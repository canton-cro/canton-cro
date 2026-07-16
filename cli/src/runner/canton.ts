import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { StepId } from "../steps.js";
import type { RunConfig } from "../state.js";
import { runDir } from "../state.js";
import { loadFacts } from "../facts.js";
import { AcsImportFaultError, diagnoseRealAcsImportFault } from "../fault.js";
import type { StepContext, StepResult } from "./stub.js";

/**
 * On Windows, Node spawn cannot exec the Unix `bin/canton` shim — use canton.bat.
 * Git Bash can run the shim; cro init may still store the Unix path in config.
 */
export function resolveCantonExecutable(bin: string): string {
  if (process.platform !== "win32") return bin;
  if (/\.(bat|cmd)$/i.test(bin)) return bin;
  const base = bin.replace(/\\/g, "/").split("/").pop() ?? "";
  if (base !== "canton") return bin;
  const bat = join(dirname(bin), "canton.bat");
  return existsSync(bat) ? bat : bin;
}

/** Embed paths in Scala string literals (backslash = escape → use /). */
export function forScalaPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Real Canton adapter (A6, minimal v1).
 *
 * Strategy: the localnet nodes run as a long-lived daemon
 * (localnet/bootstrap-daemon.canton). Each step is executed as a short-lived
 * remote console script: `canton run <step.sc> -c <remote-topology.conf>`.
 * Scripts print `CRO_VAR key=value` lines to pass values between steps
 * (beforeActivationOffset, targetLedgerEnd); the runner persists them in
 * runs/<id>/vars.json.
 *
 * Scope guard: no key/seed material is ever read or written — ACS export
 * files and topology transactions only (see docs/manual-baseline.md).
 */

export interface CantonRunnerSettings {
  /** Path to the canton executable (bin/canton or bin\canton.bat). */
  bin: string;
  /** Remote console config (localnet/remote-topology.conf). */
  remoteConf: string;
  /** DAR uploaded/vetted on target in step vet_packages. */
  darPath?: string;
  /** Per-step console timeout in ms (default 300s). */
  stepTimeoutMs?: number;
}

export function resolveCantonSettings(config: RunConfig): CantonRunnerSettings {
  const bin = config.canton?.bin ?? process.env.CANTON_BIN;
  const remoteConf = config.canton?.remoteConf ?? process.env.CRO_REMOTE_CONF;
  const darPath = config.canton?.darPath ?? process.env.CRO_DAR_PATH;
  if (!bin || !remoteConf) {
    throw new Error(
      "canton runner needs bin + remoteConf (config.canton or CANTON_BIN / CRO_REMOTE_CONF env)",
    );
  }
  return { bin, remoteConf, darPath, stepTimeoutMs: 300_000 };
}

// ---------------------------------------------------------------------------
// vars.json — cross-step values (offsets), populated from CRO_VAR stdout lines
// ---------------------------------------------------------------------------

export type RunVars = Record<string, string>;

export function varsPath(runId: string, cwd = process.cwd()): string {
  return join(runDir(runId, cwd), "vars.json");
}

export function loadVars(runId: string, cwd = process.cwd()): RunVars {
  const p = varsPath(runId, cwd);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as RunVars;
}

export function saveVars(runId: string, vars: RunVars, cwd = process.cwd()): void {
  mkdirSync(runDir(runId, cwd), { recursive: true });
  writeFileSync(varsPath(runId, cwd), JSON.stringify(vars, null, 2) + "\n", "utf8");
}

export function parseCroVars(stdout: string): RunVars {
  const vars: RunVars = {};
  for (const m of stdout.matchAll(/^CRO_VAR ([A-Za-z0-9_]+)=(.*)$/gm)) {
    vars[m[1]!] = m[2]!.trim();
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Scala step scripts (remote console). Node names come from config
// (source/target aliases match remote-topology.conf node names).
// Commands follow docs/manual-baseline.md (Canton Operate 3.5).
// ---------------------------------------------------------------------------

interface ScriptParams {
  source: string;
  target: string;
  syncAlias: string;
  partyId: string;
  darPath: string;
  acsFile: string;
  vars: RunVars;
}

function prelude(p: ScriptParams): string {
  return `
import com.digitalasset.canton.topology.PartyId
import com.digitalasset.canton.topology.transaction.ParticipantPermission
import scala.concurrent.duration._

val croSource = ${p.source}
val croTarget = ${p.target}
val croSync = "${p.syncAlias}"
val croParty = PartyId.tryFromProtoPrimitive("${p.partyId}")
// Read the synchronizer id from source: source stays connected for the whole
// flow, target is isolated between disconnect_all and reconnect.
val croSyncId = croSource.synchronizers.id_of(croSync)
`;
}

function requireVar(vars: RunVars, key: string, step: StepId): string {
  const v = vars[key];
  if (!v) {
    throw new Error(
      `step ${step} needs var '${key}' from an earlier step — run steps in order (vars.json)`,
    );
  }
  return v;
}

function stepBody(stepId: StepId, p: ScriptParams): string {
  switch (stepId) {
    case "vet_packages":
      return `
croTarget.dars.upload("${forScalaPath(p.darPath)}")
val croMainPkg = croSource.dars.list(filterName = "CantonExamples").headOption.map(_.mainPackageId).getOrElse {
  println("CRO_ERR CantonExamples DAR not present on source"); sys.exit(1); ""
}
val croVetted = croTarget.topology.vetted_packages.list()
  .exists(_.item.packages.exists(_.packageId == croMainPkg))
if (!croVetted) { println("CRO_ERR main package not vetted on target"); sys.exit(1) }
println(s"CRO_VAR mainPackageId=$croMainPkg")
`;
    case "data_retention":
      return `
val croSched = croSource.pruning.get_schedule()
println(s"CRO_INFO pruning_schedule_before=$croSched")
if (croSched.isDefined) { croSource.pruning.clear_schedule() }
val croAfter = croSource.pruning.get_schedule()
if (croAfter.isDefined) { println("CRO_ERR pruning schedule not cleared"); sys.exit(1) }
println("CRO_VAR pruningCleared=true")
`;
    case "target_authorize":
      return `
croTarget.topology.party_to_participant_mappings.propose_delta(
  party = croParty,
  adds = Seq((croTarget.id, ParticipantPermission.Observation)),
  store = croSyncId,
  requiresPartyToBeOnboarded = true,
)
println("CRO_VAR targetAuthorized=true")
`;
    case "disconnect_all":
      return `
croTarget.synchronizers.disconnect_all()
val croConn = croTarget.synchronizers.list_connected()
if (croConn.nonEmpty) { println(s"CRO_ERR target still connected: $croConn"); sys.exit(1) }
println("CRO_VAR targetDisconnected=true")
`;
    case "disable_auto_reconnect":
      return `
croTarget.synchronizers.modify(croSync, _.copy(manualConnect = true))
println(s"CRO_INFO sync_config=" + croTarget.synchronizers.config(croSync))
println("CRO_VAR manualConnect=true")
`;
    case "source_authorize":
      return `
val croBeforeActivationOffset = croSource.ledger_api.state.end()
croSource.topology.party_to_participant_mappings.propose_delta(
  party = croParty,
  adds = Seq((croTarget.id, ParticipantPermission.Observation)),
  store = croSyncId,
  requiresPartyToBeOnboarded = true,
)
println(s"CRO_VAR beforeActivationOffset=$croBeforeActivationOffset")
`;
    case "export_acs": {
      const off = requireVar(p.vars, "beforeActivationOffset", "export_acs");
      return `
croSource.parties.export_party_acs(
  party = croParty,
  synchronizerId = croSyncId,
  targetParticipantId = croTarget.id,
  beginOffsetExclusive = ${off}L,
  exportFilePath = "${forScalaPath(p.acsFile)}",
)
println("CRO_VAR acsExported=true")
`;
    }
    case "reenable_pruning":
      return `
// Optional step. Memory-storage localnet had no schedule to restore
// (see data_retention CRO_INFO). Restore the original cron here when
// running against a production participant with automatic pruning.
println("CRO_INFO no pruning schedule to restore on memory localnet")
println("CRO_VAR pruningRestored=noop")
`;
    case "backup_target":
      // Handled in runCantonStep (memory storage => documented skip;
      // postgres path is A8 scope together with real restore drills).
      return "";
    case "import_acs": {
      return `
croTarget.parties.import_party_acs(
  synchronizerId = croSyncId,
  party = Some(croParty),
  importFilePath = "${forScalaPath(p.acsFile)}",
)
println("CRO_VAR acsImported=true")
`;
    }
    case "reconnect":
      return `
val croTargetLedgerEnd = croTarget.ledger_api.state.end()
val croOk = croTarget.synchronizers.reconnect_local(croSync)
if (!croOk) { println("CRO_ERR reconnect_local returned false"); sys.exit(1) }
println(s"CRO_VAR targetLedgerEnd=$croTargetLedgerEnd")
println("CRO_VAR reconnected=true")
`;
    case "reenable_auto_reconnect":
      return `
croTarget.synchronizers.modify(croSync, _.copy(manualConnect = false))
println(s"CRO_INFO sync_config=" + croTarget.synchronizers.config(croSync))
println("CRO_VAR manualConnect=false")
`;
    case "clear_onboarding_flag": {
      const tle = requireVar(p.vars, "targetLedgerEnd", "clear_onboarding_flag");
      return `
utils.retry_until_true(timeout = 2.minutes) {
  val croFlag = croTarget.parties.clear_party_onboarding_flag(croParty, croSyncId, ${tle}L)
  println(s"CRO_INFO clear_flag=$croFlag")
  croFlag.toString.contains("FlagNotSet")
}
println("CRO_VAR onboardingFlagCleared=true")
`;
    }
    default: {
      const exhaustive: never = stepId;
      throw new Error(`no canton script for step ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** JVM locale pin: TR Windows breaks Daml-LF identifiers (TIME -> TİME). */
export const LOCALE_JAVA_OPTS = "-Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8";

/** Run a console script against the daemon via remote config (shared by steps + probes). */
export function execConsoleScript(
  settings: CantonRunnerSettings,
  scriptPath: string,
): SpawnSyncReturns<string> {
  const bin = resolveCantonExecutable(settings.bin);
  const useShell = process.platform === "win32" && /\.(bat|cmd)$/i.test(bin);
  return spawnSync(
    bin,
    ["run", scriptPath, "-c", settings.remoteConf, "--log-level-stdout=WARN"],
    {
      encoding: "utf8",
      timeout: settings.stepTimeoutMs ?? 300_000,
      // .bat launchers require a shell on Windows.
      shell: useShell,
      env: {
        ...process.env,
        JAVA_TOOL_OPTIONS: process.env.JAVA_TOOL_OPTIONS ?? LOCALE_JAVA_OPTS,
      },
    },
  );
}

/**
 * Deterministic snapshot corruption (A8): keep the first half of the bytes,
 * append fixed junk. Same input file -> same corrupted output. Canton then
 * fails the import for REAL (gzip/validation error), not via simulation.
 */
export function corruptSnapshot(path: string): void {
  const buf = readFileSync(path);
  const half = buf.subarray(0, Math.max(1, Math.floor(buf.length / 2)));
  const junk = Buffer.from("CRO_FAULT_JUNK_".repeat(8), "utf8");
  writeFileSync(path, Buffer.concat([half, junk]));
}

export function runCantonStep(ctx: StepContext, cwd = process.cwd()): StepResult {
  const { runId, stepId, config } = ctx;

  if (config.faultInjection === "partial-acs-import") {
    throw new Error(
      "partial-acs-import cannot be produced deterministically on a real ledger in v1 — " +
        "it stays stub-only (see run log A8); use --fault broken-acs-import for the real drill",
    );
  }

  const settings = resolveCantonSettings(config);
  const dir = runDir(runId, cwd);
  const scriptsDir = join(dir, "scripts");
  const logsDir = join(dir, "logs");
  const acsDir = join(dir, "acs");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(acsDir, { recursive: true });

  // Step 9 (backup_target): memory storage has no pg_dump equivalent —
  // documented no-op per baseline step 9 + preflight memory_storage_backup_note.
  if (stepId === "backup_target") {
    const facts = loadFacts(runId, cwd);
    if (facts.storageKind === "memory" || facts.storageKind === "h2") {
      return {
        ok: true,
        skipped: true,
        message:
          `${facts.storageKind} storage: backup step is a documented no-op in v1 ` +
          "(baseline step 9 note) — real backup + restore-from-backup lands with the A8 drill",
      };
    }
    throw new Error(
      `backup_target for storageKind=${facts.storageKind} is not implemented in v1 ` +
        "(postgres pg_dump path arrives with A8 restore drills)",
    );
  }

  const vars = loadVars(runId, cwd);
  const params: ScriptParams = {
    source: config.source,
    target: config.target,
    syncAlias: config.syncAlias,
    partyId: config.partyId,
    darPath: settings.darPath ?? "",
    acsFile: join(acsDir, "party_replication.acs.gz"),
    vars,
  };
  if (stepId === "vet_packages" && !params.darPath) {
    throw new Error("vet_packages needs canton.darPath (or CRO_DAR_PATH env)");
  }

  // A8 real fault: before the real import, keep a pristine snapshot copy
  // (the rollback artifact) and deterministically corrupt the live file.
  const goodSnapshot = params.acsFile + ".good";
  const realFaultArmed =
    stepId === "import_acs" && config.faultInjection === "broken-acs-import";
  if (realFaultArmed) {
    if (!existsSync(params.acsFile)) {
      throw new Error("broken-acs-import drill needs an exported snapshot (run export_acs first)");
    }
    if (!existsSync(goodSnapshot)) {
      copyFileSync(params.acsFile, goodSnapshot);
    }
    corruptSnapshot(params.acsFile);
  }

  const script = prelude(params) + stepBody(stepId, params);
  const scriptPath = join(scriptsDir, `${stepId}.sc`);
  writeFileSync(scriptPath, script, "utf8");

  const res = execConsoleScript(settings, scriptPath);

  const logPath = join(logsDir, `${stepId}.log`);
  writeFileSync(
    logPath,
    `# canton run ${stepId} — exit=${res.status}\n--- stdout ---\n${res.stdout ?? ""}\n--- stderr ---\n${res.stderr ?? ""}`,
    "utf8",
  );

  if (res.error) {
    throw new Error(`step ${stepId}: failed to launch canton (${res.error.message})`);
  }
  const stdout = res.stdout ?? "";
  const croErr = stdout.match(/^CRO_ERR (.*)$/m)?.[1];
  if (res.status !== 0 || croErr) {
    if (realFaultArmed) {
      // REAL failure from Canton (corrupted snapshot rejected) -> structured
      // diagnosis with the actual console error lines; machine safe-stops.
      const combined = `${res.stderr ?? ""}\n${stdout}`;
      const errorLines = combined
        .split("\n")
        .filter((l) => /error|exception|failure|invalid|corrupt/i.test(l))
        .join("\n");
      throw new AcsImportFaultError(
        diagnoseRealAcsImportFault(
          config.partyId,
          errorLines || combined.split("\n").slice(-10).join("\n"),
          goodSnapshot,
          logPath,
        ),
      );
    }
    throw new Error(
      `step ${stepId}: canton console exited ${res.status}` +
        (croErr ? ` — ${croErr}` : "") +
        ` (log: ${logPath})`,
    );
  }
  if (realFaultArmed) {
    // Canton accepted a corrupted snapshot — the drill itself is invalid.
    throw new Error(
      "broken-acs-import drill invalid: import succeeded despite corrupted snapshot " +
        `(log: ${logPath})`,
    );
  }

  const newVars = parseCroVars(stdout);
  if (Object.keys(newVars).length > 0) {
    saveVars(runId, { ...vars, ...newVars }, cwd);
  }

  // TS-side post-condition: export must leave a non-empty snapshot file.
  if (stepId === "export_acs") {
    if (!existsSync(params.acsFile) || statSync(params.acsFile).size === 0) {
      throw new Error(`step export_acs: snapshot missing or empty at ${params.acsFile}`);
    }
    return {
      ok: true,
      message: `real: export_acs wrote ${statSync(params.acsFile).size} bytes (${params.acsFile})`,
    };
  }

  return {
    ok: true,
    message: `real: ${stepId} ok${Object.keys(newVars).length ? ` (${Object.entries(newVars).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`,
  };
}

/** Async wrapper matching the machine's execute signature. */
export function makeCantonRunner(cwd = process.cwd()) {
  return async (ctx: StepContext): Promise<StepResult> => runCantonStep(ctx, cwd);
}
