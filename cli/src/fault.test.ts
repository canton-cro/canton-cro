import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createInitialState,
  saveState,
  writeConfig,
  loadState,
  diagnosisPath,
  type RunConfig,
} from "./state.js";
import { defaultStubFacts, writeFacts } from "./facts.js";
import { runMachine } from "./machine.js";

const base: RunConfig = {
  source: "participant1",
  target: "participant2",
  syncAlias: "da",
  partyId: "Alice::fault",
  runOptionalSteps: true,
  faultInjection: "none",
};

describe("ACS fault injection", () => {
  it("broken-acs-import: safe stop with diagnosis, no reconnect", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cro-fault-"));
    try {
      const runId = "brk";
      const cfg: RunConfig = { ...base, faultInjection: "broken-acs-import" };
      writeConfig(runId, cfg, cwd);
      writeFacts(runId, defaultStubFacts(), cwd);
      saveState(createInitialState(runId, cfg), cwd);

      const result = await runMachine(runId, "apply", { cwd });
      assert.equal(result.exitCode, 1);
      assert.match(result.message, /SAFE STOP/);

      const state = loadState(runId, cwd);
      assert.equal(state.status, "failed");
      const importStep = state.steps.find((s) => s.id === "import_acs")!;
      const reconnect = state.steps.find((s) => s.id === "reconnect")!;
      const clear = state.steps.find((s) => s.id === "clear_onboarding_flag")!;
      assert.equal(importStep.status, "failed");
      assert.equal(reconnect.status, "pending");
      assert.equal(clear.status, "pending");

      assert.ok(existsSync(diagnosisPath(runId, cwd)));
      const d = JSON.parse(readFileSync(diagnosisPath(runId, cwd), "utf8"));
      assert.equal(d.fault, "broken-acs-import");
      assert.equal(d.safeStop, true);
      assert.match(d.code, /ACS_COMMITMENT/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("partial-acs-import: ACS_IMPORT_INCOMPLETE diagnosis", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cro-fault-"));
    try {
      const runId = "part";
      const cfg: RunConfig = { ...base, faultInjection: "partial-acs-import" };
      writeConfig(runId, cfg, cwd);
      writeFacts(runId, defaultStubFacts(), cwd);
      saveState(createInitialState(runId, cfg), cwd);

      const result = await runMachine(runId, "apply", { cwd });
      assert.equal(result.exitCode, 1);
      const d = JSON.parse(readFileSync(diagnosisPath(runId, cwd), "utf8"));
      assert.equal(d.code, "ACS_IMPORT_INCOMPLETE");
      assert.equal(d.step, "import_acs");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("A8 real-fault helpers", () => {
  it("extractCantonErrorCode finds real codes, falls back generically", async () => {
    const { extractCantonErrorCode } = await import("./fault.js");
    assert.equal(
      extractCantonErrorCode("GrpcClientError: INVALID_ARGUMENT/IMPORT_ACS_ERROR(8,xx): bad"),
      "IMPORT_ACS_ERROR",
    );
    assert.equal(
      extractCantonErrorCode("warn: ACS_COMMITMENT_MISMATCH detected"),
      "ACS_COMMITMENT_MISMATCH",
    );
    assert.equal(
      extractCantonErrorCode(
        "GrpcClientError: INVALID_ARGUMENT/PROTO_DESERIALIZATION_FAILURE(8,a252): bad proto",
      ),
      "PROTO_DESERIALIZATION_FAILURE",
    );
    assert.equal(extractCantonErrorCode("something exploded"), "ACS_IMPORT_FAILED");
  });

  it("diagnoseRealAcsImportFault carries real error lines + rollback path", async () => {
    const { diagnoseRealAcsImportFault } = await import("./fault.js");
    const d = diagnoseRealAcsImportFault(
      "Alice::x",
      "ERROR IMPORT_ACS_ERROR(8): snapshot corrupt\nsecond line",
      "/runs/x/acs/f.gz.good",
      "/runs/x/logs/import_acs.log",
    );
    assert.equal(d.code, "IMPORT_ACS_ERROR");
    assert.match(d.summary, /REAL/);
    assert.ok(d.observed[0]!.includes("snapshot corrupt"));
    assert.ok(d.nextActions.some((a) => a.includes(".good")));
    assert.equal(d.safeStop, true);
  });

  it("corruptSnapshot is deterministic and always changes the file", async () => {
    const { corruptSnapshot } = await import("./runner/canton.js");
    const { writeFileSync, readFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "cro-corrupt-"));
    try {
      const f = join(dir, "snap.gz");
      const orig = Buffer.from("0123456789abcdef0123456789abcdef");
      writeFileSync(f, orig);
      corruptSnapshot(f);
      const once = readFileSync(f);
      assert.notDeepEqual(once, orig);
      // deterministic: same input -> same corrupted output
      writeFileSync(f, orig);
      corruptSnapshot(f);
      assert.deepEqual(readFileSync(f), once);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
