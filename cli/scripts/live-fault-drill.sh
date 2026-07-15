#!/usr/bin/env bash
# CRO A8: REAL broken-ACS drill against a live Canton localnet.
#   fault -> real Canton import error -> safe stop + diagnosis
#   -> verify target clean -> restore pristine snapshot -> resume -> completed.
# No simulation: the import failure comes from Canton rejecting a corrupted
# snapshot; the recovery is a real resume that finishes the replication.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VER="${CANTON_VERSION:-3.5.8}"
NAME="canton-open-source-${VER}"
VENDOR="$ROOT/vendor"
CANTON_DIR="$VENDOR/$NAME"
CANTON_BIN="$CANTON_DIR/bin/canton"
DAR="$CANTON_DIR/dars/CantonExamples.dar"
REMOTE_CONF="$ROOT/localnet/remote-topology.conf"
RUN_ID="${1:-fault-a8}"
OUT="$ROOT/localnet/out"
LOCALE_OPTS="-Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8"

mkdir -p "$OUT"

if [[ ! -x "$CANTON_BIN" ]]; then
  echo "Canton OSS not found — downloading ${VER}..."
  mkdir -p "$VENDOR"
  ARCHIVE="${NAME}.tar.gz"
  curl -fsSL -o "$VENDOR/$ARCHIVE" \
    "https://github.com/digital-asset/canton/releases/download/v${VER}/${ARCHIVE}"
  tar -xzf "$VENDOR/$ARCHIVE" -C "$VENDOR"
fi

# --- 1) Daemon up (fresh H2) ---------------------------------------------------
export JAVA_TOOL_OPTIONS="$LOCALE_OPTS"
DAEMON_LOG="$OUT/fault-daemon.log"
H2_WORK="$OUT/h2-fault"
rm -f "$DAEMON_LOG"
rm -rf "$H2_WORK"
mkdir -p "$H2_WORK"
(
  cd "$H2_WORK" && exec "$CANTON_BIN" daemon \
    -c "$CANTON_DIR/config/storage/h2.conf" \
    -c "$ROOT/localnet/cro-topology.conf" \
    --bootstrap "$ROOT/localnet/bootstrap-daemon.canton" \
    --log-level-stdout=WARN
) >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
trap 'kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true' EXIT

echo "waiting for daemon (CRO_DAEMON_READY)..."
for _ in $(seq 1 120); do
  grep -q "CRO_DAEMON_READY" "$DAEMON_LOG" 2>/dev/null && break
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "fault-drill FAIL: daemon died during bootstrap — see $DAEMON_LOG"
    exit 1
  fi
  sleep 2
done
grep -q "CRO_DAEMON_READY" "$DAEMON_LOG" || {
  echo "fault-drill FAIL: daemon not ready — see $DAEMON_LOG"
  exit 1
}
echo "daemon ready."

# --- 2) Party + contract -------------------------------------------------------
PARTY_HINT="alice-$$"
SETUP_OUT="$OUT/fault-setup.out"
JAVA_TOOL_OPTIONS="$LOCALE_OPTS \"-Dcro.dar=$DAR\" \"-Dcro.partyHint=$PARTY_HINT\"" \
  "$CANTON_BIN" run "$ROOT/localnet/scripts/step0-setup.sc" \
  -c "$REMOTE_CONF" --log-level-stdout=WARN | tee "$SETUP_OUT"
grep -q "CRO_SETUP_OK" "$SETUP_OUT" || { echo "fault-drill FAIL: setup"; exit 1; }
PARTY="$(grep -oE '^CRO_VAR partyId=.*$' "$SETUP_OUT" | head -1 | cut -d= -f2)"
echo "party: $PARTY"

# --- 3) Init + drill (REAL fault at import_acs) --------------------------------
cd "$ROOT/cli"
rm -rf "runs/$RUN_ID"
CRO="node node_modules/.bin/tsx src/index.ts"
$CRO init --run "$RUN_ID" --party-id "$PARTY" \
  --runner canton --canton-bin "$CANTON_BIN" --remote-conf "$REMOTE_CONF" \
  --dar-path "$DAR" --storage-kind h2

# cro drill: apply with fault, asserts SAFE STOP + import_acs=failed +
# reconnect still pending + diagnosis.json written (exits 0 on drill PASS).
$CRO drill --run "$RUN_ID" --fault broken-acs-import

# Diagnosis must carry a REAL Canton code, not the stub text.
node -e '
  const d = require("./runs/'"$RUN_ID"'/diagnosis.json");
  if (!d.summary.includes("REAL")) { console.error("fault-drill FAIL: stub diagnosis"); process.exit(1); }
  if (!/[A-Z_]{5,}/.test(d.code)) { console.error("fault-drill FAIL: no error code"); process.exit(1); }
  console.log("diagnosis code:", d.code);
'

# --- 4) Safe-stop proof: target clean after FAILED import -----------------------
CLEAN_OUT="$OUT/fault-clean.out"
JAVA_TOOL_OPTIONS="$LOCALE_OPTS \"-Dcro.party=$PARTY\"" \
  "$CANTON_BIN" run "$ROOT/localnet/scripts/assert-clean-target.sc" \
  -c "$REMOTE_CONF" --log-level-stdout=WARN | tee "$CLEAN_OUT"
grep -q "CRO_CLEAN_OK" "$CLEAN_OUT" || { echo "fault-drill FAIL: target not clean"; exit 1; }

# --- 5) Rollback: restore pristine snapshot + disarm fault ----------------------
ACS="runs/$RUN_ID/acs/party_replication.acs.gz"
[[ -f "$ACS.good" ]] || { echo "fault-drill FAIL: pristine snapshot missing"; exit 1; }
cp "$ACS.good" "$ACS"
node -e '
  const fs = require("fs");
  const p = "runs/'"$RUN_ID"'/config.json";
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.faultInjection = "none";
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
'
echo "rollback done: snapshot restored, fault disarmed"

# --- 6) Resume: recovery completes the replication ------------------------------
$CRO resume --run "$RUN_ID"

# --- 7) Final assert: replication actually landed --------------------------------
ASSERT_OUT="$OUT/fault-assert.out"
JAVA_TOOL_OPTIONS="$LOCALE_OPTS \"-Dcro.party=$PARTY\"" \
  "$CANTON_BIN" run "$ROOT/localnet/scripts/final-assert.sc" \
  -c "$REMOTE_CONF" --log-level-stdout=WARN | tee "$ASSERT_OUT"
grep -q "CRO_ASSERT_OK" "$ASSERT_OUT" || { echo "fault-drill FAIL: final assert"; exit 1; }

echo ""
echo "fault-drill OK — REAL break -> diagnosis -> clean-target proof -> restore -> resume -> completed (run: $RUN_ID)"
echo "evidence: cli/runs/$RUN_ID/{diagnosis.json,state.json,events.jsonl,logs/}, $OUT/fault-*.out"
