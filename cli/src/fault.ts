import type { StepId } from "./steps.js";

export const FAULT_INJECTIONS = ["none", "broken-acs-import", "partial-acs-import"] as const;
export type FaultInjection = (typeof FAULT_INJECTIONS)[number];

export interface AcsFaultDiagnosis {
  fault: Exclude<FaultInjection, "none">;
  step: StepId;
  code: string;
  summary: string;
  observed: string[];
  safeStop: true;
  doNot: string[];
  nextActions: string[];
  baselineRef: string;
}

export class AcsImportFaultError extends Error {
  readonly diagnosis: AcsFaultDiagnosis;

  constructor(diagnosis: AcsFaultDiagnosis) {
    super(`${diagnosis.code}: ${diagnosis.summary}`);
    this.name = "AcsImportFaultError";
    this.diagnosis = diagnosis;
  }
}

export function diagnoseBrokenAcsImport(partyId: string): AcsFaultDiagnosis {
  return {
    fault: "broken-acs-import",
    step: "import_acs",
    code: "ACS_COMMITMENT_MISMATCH_OR_CORRUPT_SNAPSHOT",
    summary: `Simulated broken/corrupt ACS import for party ${partyId}`,
    observed: [
      "ACS snapshot failed validation or is truncated/corrupt",
      "Target ACS no longer matches source commitments (symptom class: ACS_COMMITMENT_MISMATCH)",
      "Import aborted before a consistent party ACS was established",
    ],
    safeStop: true,
    doNot: [
      "Do not reconnect the target to synchronizers with a half-imported ACS",
      "Do not clear the onboarding flag",
      "Do not continue apply; remaining steps stay pending",
    ],
    nextActions: [
      "Restore target participant from the backup taken before import (baseline step backup_target)",
      "Re-export ACS from source if the snapshot file is suspect",
      "Fix faultInjection to none (or remove --fault), then: cro resume --run <id>",
    ],
    baselineRef:
      "docs/manual-baseline.md steps 9-10; Canton DR: ACS_COMMITMENT_MISMATCH after failed import",
  };
}

export function diagnosePartialAcsImport(partyId: string): AcsFaultDiagnosis {
  return {
    fault: "partial-acs-import",
    step: "import_acs",
    code: "ACS_IMPORT_INCOMPLETE",
    summary: `Simulated partial ACS import (incomplete contract set) for party ${partyId}`,
    observed: [
      "Import interrupted mid-stream: only a subset of active contracts landed on target",
      "Party may appear hosted while ACS is incomplete",
      "Subsequent ledger activity risks commitment / confirmation failures",
    ],
    safeStop: true,
    doNot: [
      "Do not reconnect until ACS is restored to a clean backup",
      "Do not treat intermittent ACS commitment noise during happy-path onboarding the same as this failure (baseline: expected only during successful onboarding)",
    ],
    nextActions: [
      "Restore target from pre-import backup",
      "Retry full import with a complete export file",
      "Clear faultInjection, then: cro resume --run <id>",
    ],
    baselineRef: "docs/manual-baseline.md steps 9-10 (interrupted import -> backup reset)",
  };
}

/** Pull the Canton error code out of real console output (fallback: generic). */
export function extractCantonErrorCode(realError: string): string {
  const m = realError.match(
    /\b(IMPORT_ACS_ERROR|ACS_COMMITMENT_MISMATCH[A-Z_]*|[A-Z][A-Z_]{4,}(?:ERROR|FAILURE|MISMATCH))\b/,
  );
  return m?.[1] ?? "ACS_IMPORT_FAILED";
}

/**
 * Diagnosis for a REAL failed import (canton runner, A8 drill): observed lines
 * come from the actual Canton console output, and the recovery path uses the
 * pristine snapshot copy taken before fault injection.
 */
export function diagnoseRealAcsImportFault(
  partyId: string,
  realError: string,
  goodSnapshotPath: string,
  logPath: string,
): AcsFaultDiagnosis {
  const lines = realError
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 6);
  return {
    fault: "broken-acs-import",
    step: "import_acs",
    code: extractCantonErrorCode(realError),
    summary: `REAL Canton import failure for party ${partyId} (corrupted ACS snapshot)`,
    observed: lines.length > 0 ? lines : ["<no console output captured>", `see ${logPath}`],
    safeStop: true,
    doNot: [
      "Do not reconnect the target to synchronizers after a failed import",
      "Do not clear the onboarding flag",
      "Do not delete the pristine snapshot copy (*.good) — it is the rollback artifact",
    ],
    nextActions: [
      "Verify the target is clean: target ACS for the party must be empty (assert-clean-target.sc)",
      `Restore the pristine snapshot over the corrupted file (cp '${goodSnapshotPath}' back)`,
      'Set faultInjection to "none" in runs/<id>/config.json',
      "cro resume --run <id>  (import retries with the restored snapshot)",
    ],
    baselineRef:
      "docs/manual-baseline.md steps 9-10 + run log A8: real corrupted-snapshot drill",
  };
}

export function formatDiagnosis(d: AcsFaultDiagnosis): string {
  const lines = [
    "=== CRO DIAGNOSIS (safe stop) ===",
    `fault:     ${d.fault}`,
    `step:      ${d.step}`,
    `code:      ${d.code}`,
    `summary:   ${d.summary}`,
    `safeStop:  ${d.safeStop}`,
    "",
    "observed:",
    ...d.observed.map((o) => `  - ${o}`),
    "",
    "do NOT:",
    ...d.doNot.map((o) => `  - ${o}`),
    "",
    "next:",
    ...d.nextActions.map((o) => `  - ${o}`),
    "",
    `baseline: ${d.baselineRef}`,
    "=== END DIAGNOSIS ===",
  ];
  return lines.join("\n");
}
