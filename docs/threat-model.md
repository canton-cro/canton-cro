# CRO Threat Model

Scope: what Canton Recovery Orchestration (CRO) touches, what it never touches,
and the failure philosophy. Short and operator-facing. Every claim below is
backed by the live run log ([manual-baseline-run-log.md](manual-baseline-run-log.md)).

## What CRO is

A CLI that orchestrates the documented offline party replication procedure
(Canton Operate 3.5) plus recovery drills. It runs the same console commands an
operator would type, in the documented order, with state tracking, preflight
checks, and safe stops.

## What CRO NEVER touches

- Private keys, seeds, mnemonics, KMS material, signing operations.
- Party or participant key stores. Keys stay wherever they already are
  (participant node, external signer, KMS). CRO has no code path that reads,
  writes, exports, or transmits key material.
- Node databases directly. CRO never opens or edits a participant's storage.
  Fault drills corrupt only CRO's own exported snapshot file copy, never the
  node (see run log, A8 addendum).

This is verifiable by inspection: the runner (`cli/src/runner/canton.ts`)
generates console scripts from a fixed set of templates. None reference key,
seed, or crypto material.

## What CRO touches (the full surface)

1. **Canton Admin API and Ledger API**, through short-lived remote console
   processes (`canton run <script> -c localnet/remote-topology.conf`).
   Commands used: `dars.upload`, `topology.vetted_packages.list`,
   `topology.party_to_participant_mappings.propose_delta`,
   `synchronizers.{disconnect_all,modify,config,reconnect_local,list_connected}`,
   `pruning.{get_schedule,clear_schedule}`,
   `parties.{export_party_acs,import_party_acs,clear_party_onboarding_flag,hosted}`,
   `health.{status,ping}`, `ledger_api.state.{end,acs.of_party}`.
2. **ACS snapshot files** on local disk (`cli/runs/<id>/acs/`), plus a pristine
   `.good` copy taken before drill fault injection (the rollback artifact).
3. **Topology transactions**: party-to-participant mappings proposed with
   `requiresPartyToBeOnboarded = true`, exactly as the Canton docs prescribe.
4. **Run bookkeeping files** under `cli/runs/<id>/`: `state.json`,
   `config.json`, `facts.json` (probe-stamped), `vars.json`, `events.jsonl`,
   `diagnosis.json`, per-step logs and generated scripts.

## Trust model

- CRO runs on a host the operator already trusts with participant admin access.
  Anyone who can reach the Admin API can perform every CRO action manually;
  CRO adds **no new privilege**. Protect console/Admin API access exactly as
  you do today.
- ACS snapshot files contain contract data. Treat them with the same
  sensitivity as database backups: they stay where the operator puts them,
  and CRO never transmits them anywhere except to the target participant's
  own import command.
- CRO makes no network calls other than the Canton APIs above. There is no
  telemetry, no external service, no dashboard.

## Failure philosophy

- **Fail-safe preflight:** before `apply`, the environment is probed live
  (health, ping, party hosting, DARs, synchronizer connection, party ACS).
  If the console is unreachable, every probed fact defaults to false, preflight
  FAILS and apply is blocked. A dead environment never looks green.
  Evidence: run log, A7 addendum (negative test with daemon down).
- **Safe stop:** when a step fails, later steps stay pending. After a failed
  ACS import the tool does not reconnect the target and does not clear the
  onboarding flag. Evidence: run log, A8 addendum (real
  `PROTO_DESERIALIZATION_FAILURE`, target verified clean afterwards).
- **Deterministic drills, honest limits:** the broken-snapshot drill produces a
  real Canton failure. A partial import cannot be produced deterministically on
  a real ledger, so `partial-acs-import` is simulation-only and documented as
  such. No claim is made beyond what the drill proves.

## Out of scope (by design)

Key management or custody, wallets, dashboards and observability platforms,
party offboarding (unsupported by the protocol), hard domain or synchronizer
migration (superseded by Logical Synchronizer Upgrades), decentralized party
membership.
