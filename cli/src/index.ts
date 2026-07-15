#!/usr/bin/env node
import { Command } from "commander";
import {
  createInitialState,
  loadConfig,
  loadState,
  saveState,
  writeConfig,
  writePreflightResult,
  type RunConfig,
} from "./state.js";
import { formatStatus, runMachine } from "./machine.js";
import { defaultStubFacts, writeFacts } from "./facts.js";
import { gatherFacts } from "./runner/probe.js";
import { buildPlan, formatPlan } from "./plan.js";
import { evaluatePreflight, formatPreflightReport } from "./preflight.js";

const program = new Command();

program
  .name("cro")
  .description("Canton Recovery Orchestration — happy-path CLI skeleton (stub runner)")
  .version("0.1.0");

program
  .command("init")
  .description("Create runs/<id>/config.json, facts.json, and empty state.json")
  .requiredOption("--run <id>", "Run id")
  .option("--source <alias>", "Source participant alias", "participant1")
  .option("--target <alias>", "Target participant alias", "participant2")
  .option("--sync-alias <alias>", "Synchronizer alias", "da")
  .option("--party-id <id>", "Party id", "Alice::example")
  .option("--skip-optional", "Skip optional pruning/auto-reconnect re-enable steps", false)
  .option("--runner <kind>", "Step executor: stub | canton (env: CRO_RUNNER)")
  .option("--canton-bin <path>", "Canton executable (env: CANTON_BIN)")
  .option("--remote-conf <path>", "Remote console config (env: CRO_REMOTE_CONF)")
  .option("--dar-path <path>", "DAR for vet_packages (env: CRO_DAR_PATH)")
  .option("--storage-kind <kind>", "participant storage: memory | h2 | postgres | unknown")
  .action((opts: {
    run: string;
    source: string;
    target: string;
    syncAlias: string;
    partyId: string;
    skipOptional: boolean;
    runner?: string;
    cantonBin?: string;
    remoteConf?: string;
    darPath?: string;
    storageKind?: string;
  }) => {
    const runner = (opts.runner ?? process.env.CRO_RUNNER) as
      | RunConfig["runner"]
      | undefined;
    if (runner && runner !== "stub" && runner !== "canton") {
      throw new Error("--runner must be stub or canton");
    }
    const cantonBin = opts.cantonBin ?? process.env.CANTON_BIN;
    const remoteConf = opts.remoteConf ?? process.env.CRO_REMOTE_CONF;
    const darPath = opts.darPath ?? process.env.CRO_DAR_PATH;
    if (runner === "canton" && (!cantonBin || !remoteConf)) {
      throw new Error(
        "--runner canton needs --canton-bin and --remote-conf (or CANTON_BIN / CRO_REMOTE_CONF env)",
      );
    }
    const config: RunConfig = {
      source: opts.source,
      target: opts.target,
      syncAlias: opts.syncAlias,
      partyId: opts.partyId,
      runOptionalSteps: !opts.skipOptional,
      faultInjection: "none",
      ...(runner ? { runner } : {}),
      ...(runner === "canton" && cantonBin && remoteConf
        ? { canton: { bin: cantonBin, remoteConf, ...(darPath ? { darPath } : {}) } }
        : {}),
    };
    writeConfig(opts.run, config);
    const facts = defaultStubFacts();
    if (opts.storageKind) {
      if (!["memory", "h2", "postgres", "unknown"].includes(opts.storageKind)) {
        throw new Error("--storage-kind must be memory | h2 | postgres | unknown");
      }
      facts.storageKind = opts.storageKind as typeof facts.storageKind;
    }
    writeFacts(opts.run, facts);
    const state = createInitialState(opts.run, config);
    saveState(state);
    console.log(`Initialized run '${opts.run}'`);
    console.log(`  config: runs/${opts.run}/config.json`);
    console.log(`  facts:  runs/${opts.run}/facts.json`);
    console.log(`  state:  runs/${opts.run}/state.json`);
  });

program
  .command("plan")
  .description("List steps that would run (read-only; does not mutate state)")
  .requiredOption("--run <id>", "Run id")
  .action((opts: { run: string }) => {
    const before = JSON.stringify(loadState(opts.run));
    const state = loadState(opts.run);
    const items = buildPlan(state);
    console.log(formatPlan(state, items));
    const after = JSON.stringify(loadState(opts.run));
    if (before !== after) {
      throw new Error("plan mutated state (bug)");
    }
  });

program
  .command("preflight")
  .description("Check baseline preconditions; exit 1 on failure (does not run apply)")
  .requiredOption("--run <id>", "Run id")
  .option("--config <path>", "Override config.json path")
  .action((opts: { run: string; config?: string }) => {
    const cfg = loadConfig(opts.run, process.cwd(), opts.config);
    // canton runner: live probe (merged + persisted); stub: declared facts.json.
    const facts = gatherFacts(opts.run, cfg);
    if (facts.probe) {
      console.log(`probe: ${facts.probe.note ?? facts.probe.source} @ ${facts.probe.at}`);
    }
    const report = evaluatePreflight(cfg, facts);
    writePreflightResult(opts.run, {
      ok: report.ok,
      at: new Date().toISOString(),
      errorIds: report.errors.map((e) => e.id),
    });
    console.log(formatPreflightReport(report));
    process.exitCode = report.ok ? 0 : 1;
  });

program
  .command("apply")
  .description("Run pending steps (blocked if preflight fails)")
  .requiredOption("--run <id>", "Run id")
  .option("--config <path>", "Override config.json path")
  .option(
    "--fault <mode>",
    "Inject ACS fault at import_acs: none|broken-acs-import|partial-acs-import",
  )
  .action(async (opts: { run: string; config?: string; fault?: string }) => {
    const cfg = loadConfig(opts.run, process.cwd(), opts.config);
    if (opts.fault) {
      cfg.faultInjection = opts.fault as RunConfig["faultInjection"];
      writeConfig(opts.run, cfg);
    }
    const state = loadState(opts.run);
    state.config = cfg;
    saveState(state);
    const result = await runMachine(opts.run, "apply");
    console.log(result.message);
    process.exitCode = result.exitCode;
  });

program
  .command("drill")
  .description(
    "Fault-injection drill: apply with broken/partial ACS import, expect SAFE STOP + diagnosis",
  )
  .requiredOption("--run <id>", "Run id")
  .option(
    "--fault <mode>",
    "broken-acs-import | partial-acs-import",
    "broken-acs-import",
  )
  .action(async (opts: { run: string; fault: string }) => {
    if (opts.fault !== "broken-acs-import" && opts.fault !== "partial-acs-import") {
      throw new Error("--fault must be broken-acs-import or partial-acs-import");
    }
    const cfg = loadConfig(opts.run);
    cfg.faultInjection = opts.fault;
    writeConfig(opts.run, cfg);
    const state = loadState(opts.run);
    // Reset to idle pending for a clean drill if previously completed
    if (state.status === "completed" || state.status === "failed") {
      const fresh = createInitialState(opts.run, cfg);
      saveState(fresh);
    } else {
      state.config = cfg;
      saveState(state);
    }
    const result = await runMachine(opts.run, "apply");
    console.log(result.message);
    if (result.exitCode === 0) {
      console.error("drill FAIL: expected SAFE STOP at import_acs");
      process.exitCode = 1;
      return;
    }
    const st = loadState(opts.run);
    const importStep = st.steps.find((s) => s.id === "import_acs");
    const reconnect = st.steps.find((s) => s.id === "reconnect");
    if (importStep?.status !== "failed" || reconnect?.status !== "pending") {
      console.error("drill FAIL: expected import_acs=failed and later steps still pending");
      process.exitCode = 1;
      return;
    }
    const { existsSync } = await import("node:fs");
    const { diagnosisPath } = await import("./state.js");
    if (!existsSync(diagnosisPath(opts.run))) {
      console.error("drill FAIL: diagnosis.json missing");
      process.exitCode = 1;
      return;
    }
    console.log("drill PASS: fault caught, diagnosis written, safe stop (no reconnect)");
    process.exitCode = 0;
  });

program
  .command("resume")
  .description("Retry failed step (or continue pending) and finish the run")
  .requiredOption("--run <id>", "Run id")
  .action(async (opts: { run: string }) => {
    // Reload config.json so recovery edits (e.g. faultInjection back to
    // "none" after a drill) take effect — state.config is a snapshot from
    // the failed apply and would otherwise re-inject the fault.
    const cfg = loadConfig(opts.run);
    const state = loadState(opts.run);
    state.config = cfg;
    saveState(state);
    const result = await runMachine(opts.run, "resume");
    console.log(result.message);
    process.exitCode = result.exitCode;
  });

program
  .command("status")
  .description("Print run state machine status")
  .requiredOption("--run <id>", "Run id")
  .action((opts: { run: string }) => {
    const state = loadState(opts.run);
    console.log(formatStatus(state));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
