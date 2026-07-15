#!/usr/bin/env bash
# ACS fault-injection drill (broken + partial). Expects deps already installed.
# cro drill exits 0 when the fault is caught with diagnosis + safe stop.
set -euo pipefail
cd "$(dirname "$0")/.."

run_fault() {
  local run_id="$1"
  local fault="$2"
  npm run cro -- init --run "$run_id"
  npm run cro -- drill --run "$run_id" --fault "$fault"
  if [[ ! -f "runs/$run_id/diagnosis.json" ]]; then
    echo "fault-drill FAIL: missing runs/$run_id/diagnosis.json"
    exit 1
  fi
  echo "fault-drill OK for $fault"
}

run_fault ci-fault-broken broken-acs-import
run_fault ci-fault-partial partial-acs-import
echo "fault-drill OK"
