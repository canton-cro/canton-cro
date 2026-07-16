#!/usr/bin/env bash
# CRO live drill (A6 proof): full 13-step offline party replication against a
# REAL Canton localnet — no stub. Flow:
#   daemon up -> step0 setup (party + contract) -> cro init/plan/preflight/apply
#   -> idempotent re-apply -> final ACS assert on target -> daemon down.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VER="${CANTON_VERSION:-3.5.8}"
NAME="canton-open-source-${VER}"
VENDOR="$ROOT/vendor"
CANTON_DIR="$VENDOR/$NAME"
CANTON_BIN="$CANTON_DIR/bin/canton"
DAR="$CANTON_DIR/dars/CantonExamples.dar"
REMOTE_CONF="$ROOT/localnet/remote-topology.conf"
RUN_ID="${1:-live-happy}"
OUT="$ROOT/localnet/out"
LOCALE_OPTS="-Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8"

# Git Bash paths (/c/...) inside JAVA_TOOL_OPTIONS / Node args are NOT converted
# for Windows Java. Use mixed native paths (C:/...) when handing off.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

mkdir -p "$OUT"

# --- Canton OSS (reuse localnet-drill.sh download logic) ---------------------
if [[ ! -x "$CANTON_BIN" ]]; then
  echo "Canton OSS not found — downloading ${VER}..."
  mkdir -p "$VENDOR"
  ARCHIVE="${NAME}.tar.gz"
  curl -fsSL -o "$VENDOR/$ARCHIVE" \
    "https://github.com/digital-asset/canton/releases/download/v${VER}/${ARCHIVE}"
  tar -xzf "$VENDOR/$ARCHIVE" -C "$VENDOR"
fi

# --- 1) Daemon up (H2 persistence — memory storage cannot serve ACS import) ---
export JAVA_TOOL_OPTIONS="$LOCALE_OPTS"
DAEMON_LOG="$OUT/live-daemon.log"
H2_WORK="$OUT/h2"
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
    echo "live-drill FAIL: daemon died during bootstrap — see $DAEMON_LOG"
    exit 1
  fi
  sleep 2
done
grep -q "CRO_DAEMON_READY" "$DAEMON_LOG" || {
  echo "live-drill FAIL: daemon not ready in time — see $DAEMON_LOG"
  exit 1
}
echo "daemon ready."

# --- 2) Step 0: party + contract on source ------------------------------------
PARTY_HINT="alice-$$"
SETUP_OUT="$OUT/live-setup.out"
DAR_NATIVE="$(native_path "$DAR")"
REMOTE_NATIVE="$(native_path "$REMOTE_CONF")"
CANTON_BIN_NATIVE="$(native_path "$CANTON_BIN")"
JAVA_TOOL_OPTIONS="$LOCALE_OPTS \"-Dcro.dar=$DAR_NATIVE\" \"-Dcro.partyHint=$PARTY_HINT\"" \
  "$CANTON_BIN" run "$ROOT/localnet/scripts/step0-setup.sc" \
  -c "$REMOTE_CONF" --log-level-stdout=WARN | tee "$SETUP_OUT"
grep -q "CRO_SETUP_OK" "$SETUP_OUT" || { echo "live-drill FAIL: setup"; exit 1; }
PARTY="$(grep -oE '^CRO_VAR partyId=.*$' "$SETUP_OUT" | head -1 | cut -d= -f2)"
echo "party: $PARTY"

# --- 3) CRO init + plan + preflight + apply (real runner) ----------------------
cd "$ROOT/cli"
rm -rf "runs/$RUN_ID"  # fresh run: no stale state/vars from earlier drills
# Prefer tsx CLI entry (Windows: node_modules/.bin/tsx is a bash shim — do not
# pass it to `node`). Fall back to dist/cli.mjs.
if [[ -f node_modules/tsx/dist/cli.mjs ]]; then
  cro() { node node_modules/tsx/dist/cli.mjs src/index.ts "$@"; }
else
  cro() { ./node_modules/.bin/tsx src/index.ts "$@"; }
fi
cro init --run "$RUN_ID" --party-id "$PARTY" \
  --runner canton --canton-bin "$CANTON_BIN_NATIVE" --remote-conf "$REMOTE_NATIVE" \
  --dar-path "$DAR_NATIVE" --storage-kind h2
cro plan --run "$RUN_ID"
cro preflight --run "$RUN_ID"
cro apply --run "$RUN_ID"

# --- 4) Idempotency: second apply is a no-op -----------------------------------
SECOND="$(cro apply --run "$RUN_ID")"
echo "$SECOND"
echo "$SECOND" | grep -q "already complete" || {
  echo "live-drill FAIL: second apply was not an idempotent no-op"
  exit 1
}

# --- 5) Final assert: target really hosts the party's ACS ----------------------
ASSERT_OUT="$OUT/live-assert.out"
JAVA_TOOL_OPTIONS="$LOCALE_OPTS \"-Dcro.party=$PARTY\"" \
  "$CANTON_BIN" run "$ROOT/localnet/scripts/final-assert.sc" \
  -c "$REMOTE_CONF" --log-level-stdout=WARN | tee "$ASSERT_OUT"
grep -q "CRO_ASSERT_OK" "$ASSERT_OUT" || { echo "live-drill FAIL: final assert"; exit 1; }

echo ""
echo "live-drill OK — real 13-step offline party replication completed (run: $RUN_ID)"
echo "evidence: cli/runs/$RUN_ID/{state.json,events.jsonl,logs/,acs/}, $OUT/live-*.out"
