# CRO Operator Runbook

Procedure for running an offline party replication with CRO, and for recovering
when a step fails. This expands the rollback summary in the live run log
([manual-baseline-run-log.md](manual-baseline-run-log.md), A8 addendum).
Every step here was executed for real against Canton 3.5.8; nothing is
hypothetical.

## 0. Prerequisites

- JDK 17+, Node 20+.
- Canton OSS 3.5.8 (drill scripts download it into `vendor/` automatically).
- **Persistent storage on the participants.** Canton rejects ACS import on
  memory storage (`IMPORT_ACS_ERROR ... Use db persistence.`, run log, "Kritik
  kesif" section). The bundled localnet uses H2 file storage
  (`localnet/cro-topology.conf`). Production participants use Postgres.
- Windows: use Git Bash for the drill scripts; known pitfalls and fixes
  (locale, native paths, canton.bat) are listed in `localnet/ISSUES.md`.

## 1. Standard replication run

```bash
cd cli && npm ci

# 1. Configure the run
node node_modules/.bin/tsx src/index.ts init --run r1 \
  --party-id <full party id> \
  --source participant1 --target participant2 --sync-alias da \
  --runner canton --canton-bin <path to canton or canton.bat> \
  --remote-conf ../localnet/remote-topology.conf \
  --dar-path <DAR the party uses> --storage-kind h2

# 2. Read-only plan (mutates nothing)
... plan --run r1

# 3. Live preflight (probes the real environment)
... preflight --run r1

# 4. Execute the 13 documented steps
... apply --run r1

# 5. Status / audit at any time
... status --run r1
```

Notes:

- A second `apply` on a completed run is an idempotent no-op (proven in the
  run log, A6 section).
- Preflight runs again inside `apply`; a failing preflight blocks execution
  before any step runs.
- `cli/scripts/live-drill.sh` performs this whole sequence end to end against
  a fresh local daemon, including party setup and final verification.

## 2. Reading a preflight failure

`preflight` probes the environment live (run log, A7 addendum). Common
failures and what they mean:

| Failed check | Meaning | Action |
|---|---|---|
| `participants_reachable` / `health_ping_ok` | Console cannot reach one or both nodes, or nodes cannot see each other. All probed facts default to false when the console is unreachable: a dead environment never passes. | Start/repair the nodes, verify `remote-topology.conf` ports, rerun preflight. |
| `party_hosted_on_source` | The party is not hosted on the configured source. | Fix `--party-id` or the source alias. |
| `source_has_packages` | No DARs on the source participant. | Upload the party's DAR to the source first. |
| `target_connected_before_isolation` | Target already disconnected. | Reconnect target; isolation happens later, in step order. |
| `backup_before_import` | Operator declared no backup plan. | Prepare the target backup path (Postgres: pg_dump) and set the fact accordingly. |
| warning `party_not_already_on_target` | Party already hosted on target. | You are probably re-running a finished or in-flight replication. Resume the original run instead of starting a fresh one. |

## 3. Interrupted run (process died, machine rebooted)

State is on disk (`runs/<id>/state.json`). Run:

```bash
... resume --run r1
```

`resume` retries the failed step (or continues from the first pending one) and
reloads `runs/<id>/config.json` first, so config fixes made between apply and
resume take effect.

## 4. FAILED `import_acs`: the recovery procedure

This is the case the tool exists for. Proven end to end in the run log
(A8 addendum) with a real Canton error.

**1. Do not act on the target.** The tool has already safe-stopped:
`reconnect` and `clear_onboarding_flag` remain pending. Do not reconnect the
target to synchronizers and do not clear the onboarding flag by hand.

**2. Read the diagnosis.**

```bash
cat cli/runs/<id>/diagnosis.json
```

It contains the real console error lines, the extracted error code (observed
in practice: `PROTO_DESERIALIZATION_FAILURE` for a corrupted snapshot), the
do-not list, and the recovery actions. Full console output is in
`cli/runs/<id>/logs/import_acs.log`.

**3. Verify the target is clean.**

```bash
JAVA_TOOL_OPTIONS='... "-Dcro.party=<party id>"' \
  <canton> run localnet/scripts/assert-clean-target.sc \
  -c localnet/remote-topology.conf --log-level-stdout=WARN
```

Expected: `targetAcsCountAfterFail=0` and `CRO_CLEAN_OK`, meaning nothing
half-landed and a retry is safe. If the target ACS is NOT empty, do not
blind-retry: restore the target participant from its own database backup
(the backup taken in step `backup_target`; Postgres: pg_restore) and only
then continue.

**4. Fix the cause.** For a corrupted snapshot, restore the pristine copy:

```bash
cp cli/runs/<id>/acs/party_replication.acs.gz.good \
   cli/runs/<id>/acs/party_replication.acs.gz
```

or re-export from the source (step `export_acs` commands in the run log).
Never delete `.good` files; they are the rollback artifacts.

**5. If this was a drill,** disarm the fault in `runs/<id>/config.json`:
set `"faultInjection": "none"`.

**6. Resume.**

```bash
... resume --run <id>
```

The import retries with the restored snapshot and the remaining steps
(reconnect, flag clearance) complete.

**7. Verify the outcome.**

```bash
JAVA_TOOL_OPTIONS='... "-Dcro.party=<party id>"' \
  <canton> run localnet/scripts/final-assert.sc \
  -c localnet/remote-topology.conf --log-level-stdout=WARN
```

Expected: party visible in target topology, target sees the party's active
contracts, source ACS intact (replication, not migration), `CRO_ASSERT_OK`.

## 5. Expected noise

ACS commitment mismatch warnings during onboarding are expected and resolve on
their own (Canton docs; noted in `docs/manual-baseline.md`). Do not treat them
as an import failure mid-procedure. A failed import is signaled by the tool's
safe stop and `diagnosis.json`, not by warning noise.

## 6. Drill discipline

Run the full break/restore/resume cycle regularly so the recovery path stays
proven, not theoretical:

```bash
bash cli/scripts/live-fault-drill.sh
```

CI already runs it on every push (`live-fault-drill` job) and uploads
`diagnosis.json`, `state.json` and `events.jsonl` as artifacts. The drill has
already paid for itself once: it caught a real orchestration bug (resume
re-injecting the fault from a stale config snapshot; fixed, see run log A8).

## 7. Troubleshooting quick table

| Symptom | Cause | Fix |
|---|---|---|
| `IMPORT_ACS_ERROR ... Use db persistence` | Participant on memory storage | Use H2/Postgres topology (`localnet/cro-topology.conf`) |
| `non expected non first character ... "TIME"` at node start | Turkish Windows locale | `JAVA_TOOL_OPTIONS=-Duser.language=en -Duser.country=US` (runner sets it automatically) |
| preflight `live probe failed (exit=spawn-error)` on Windows | Node cannot exec the Unix `bin/canton` shim | Use `bin/canton.bat` (runner resolves it automatically) |
| `No such file [/c/Users/...]` in step 0 | Git Bash MSYS path inside JAVA_TOOL_OPTIONS | Drill scripts convert with `cygpath -m`; keep paths native (`C:/...`) |
| Scala `expected ([btnfr'\\"]] | UnicodeEscape)` | Windows backslashes inside generated scripts | Paths are embedded with forward slashes (`forScalaPath`) |
| `ETIMEDOUT errno -60` reading node_modules (macOS) | Repo inside an iCloud-synced folder | Keep the repo outside iCloud scope (e.g. `~/dev`) |

Details for each: `localnet/ISSUES.md`.
