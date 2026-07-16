# Canton CRO

Open-source CLI for **party/participant recovery orchestration** on Canton (offline party replication, backup validation, restore drills). No keys, no wallet, no dashboard.

**Repo:** https://github.com/canton-cro/canton-cro  
**Website:** [canton-cro.xyz](https://www.canton-cro.xyz) · **License:** [Apache-2.0](LICENSE)

```bash
git clone https://github.com/canton-cro/canton-cro.git
cd canton-cro
```

## Status

| Piece | Path |
|-------|------|
| Proje rehberi (aşamalar + vibe-coding promptlar) | [`notes/canton-recovery-orchestration-rehber.html`](notes/canton-recovery-orchestration-rehber.html) |
| Manual baseline (13 steps) | [`docs/manual-baseline.md`](docs/manual-baseline.md) |
| **LIVE run log (13/13 real steps, GO)** | [`docs/manual-baseline-run-log.md`](docs/manual-baseline-run-log.md) |
| Local 2-participant env (H2 persistent) | [`localnet/`](localnet/) — `cro-topology.conf` |
| Happy-path CLI + fault drill | [`cli/`](cli/) |
| **Real Canton adapter (A6)** | [`cli/src/runner/canton.ts`](cli/src/runner/canton.ts) + [`cli/scripts/live-drill.sh`](cli/scripts/live-drill.sh) |
| CI LocalNet / fault drill | [`.github/workflows/localnet-drill.yml`](.github/workflows/localnet-drill.yml) |
| **Threat model** (what we touch, what we never touch) | [`docs/threat-model.md`](docs/threat-model.md) |
| **Operator runbook** (incl. failed-import recovery) | [`docs/runbook.md`](docs/runbook.md) |

## Demo video

_Coming soon._ Recording plan and scene-by-scene script:
[`docs/demo-video-storyboard.md`](docs/demo-video-storyboard.md). The video
follows [`cli/scripts/live-fault-drill.sh`](cli/scripts/live-fault-drill.sh)
end to end: break -> real Canton error -> safe stop -> clean-target proof ->
restore -> resume -> completed. Everything shown on screen exists as evidence
in [`docs/manual-baseline-run-log.md`](docs/manual-baseline-run-log.md) and
`localnet/out/`.

## Quick start (CLI)

```powershell
cd cli
npm install
npm run cro -- init --run demo
npm run cro -- plan --run demo
npm run cro -- preflight --run demo
npm run cro -- apply --run demo
```

## Kanıt adımları (demo)

Bu bölüm grant / video / reviewer için **kanıt checklist**’idir. UI / metrics / alerting yok.

### A) Happy path orchestration

```powershell
cd cli
npm install
npm run cro -- init --run demo-happy
npm run cro -- plan --run demo-happy
npm run cro -- preflight --run demo-happy
npm run cro -- apply --run demo-happy
npm run cro -- status --run demo-happy
npm run cro -- apply --run demo-happy
# Beklenen: "already complete (idempotent no-op)"
```

**Kanıt:** `runs/demo-happy/state.json` → tüm zorunlu adımlar `done`; ikinci apply exit 0.

### B) Fault injection — broken / partial ACS import

Araç bilerek bozuk ACS import üretir, hatayı yakalar, teşhis basar, **reconnect yapmadan** güvenli durur.

```powershell
cd cli
npm run cro -- init --run demo-broken
npm run cro -- drill --run demo-broken --fault broken-acs-import
# veya: npm run cro -- drill --run demo-partial --fault partial-acs-import
```

**Beklenen:**

- Exit code ≠ 0
- Konsolda `=== CRO DIAGNOSIS (safe stop) ===`
- `runs/demo-broken/diagnosis.json` oluşur (`safeStop: true`, code `ACS_COMMITMENT_MISMATCH_OR_CORRUPT_SNAPSHOT` veya `ACS_IMPORT_INCOMPLETE`)
- `import_acs` = `failed`; `reconnect` / `clear_onboarding_flag` hâlâ `pending`

**Güvenli devam (demo):** fault’u kapatıp resume (gerçekte önce target backup restore):

```powershell
# config.json içinde "faultInjection": "none"
npm run cro -- resume --run demo-broken
```

### C) LocalNet — iki participant birbirini görüyor

Docker/Splice şart değil; Canton OSS `01-simple-topology` yeterli.

```powershell
# Linux/macOS CI script:
bash localnet/scripts/localnet-drill.sh

# Windows (önce JDK 17 + vendor Canton OSS; locale EN):
$env:JAVA_TOOL_OPTIONS = "-Duser.language=en -Duser.country=US"
.\localnet\scripts\health-check.ps1
```

**Kanıt:** logda `Observed archival of ping contract` + `localnet/out/ping-proof.txt` (veya CI artifact `localnet-ping-proof`).

### C2) LIVE drill — gerçek Canton, 13 gerçek adım (A6 kanıtı)

Stub yok: daemon (H2 persistence) + her adım gerçek remote console. Uçtan uca
offline party replication + idempotent ikinci apply + target'ta ACS doğrulaması.

```bash
# macOS/Linux (JDK 17+; Canton OSS otomatik iner):
bash cli/scripts/live-drill.sh
```

**Kanıt:** `docs/manual-baseline-run-log.md` (adım adım gerçek çıktılar),
`localnet/out/live-drill-proof.txt`, `localnet/out/live-a6-{state.json,events.jsonl}`.
Not: memory storage ACS import'u desteklemiyor (`IMPORT_ACS_ERROR`) — bu yüzden
`localnet/cro-topology.conf` H2 file storage kullanır.

### C3) REAL broken-ACS drill — kır, teşhis et, geri yükle, tamamla (A8 kanıtı)

Simülasyon değil: export edilen snapshot'ın pristine kopyası alınır, canlı dosya
deterministik bozulur, Canton import'u GERÇEK hatayla reddeder
(`PROTO_DESERIALIZATION_FAILURE`), araç güvenli durur, hedef temizliği kanıtlanır,
snapshot restore edilir ve `resume` replication'ı tamamlar.

```bash
bash cli/scripts/live-fault-drill.sh
```

**Beklenen akış:** `drill PASS` → `CRO_CLEAN_OK` (failed import sonrası target ACS boş)
→ `rollback done` → `completed` → `CRO_ASSERT_OK`.
**Kanıt:** `localnet/out/fault-a8-diagnosis.json` (gerçek Canton hata satırları),
`localnet/out/fault-drill-proof.txt`, run-log A8 eki (rollback runbook'u dahil).
Not: `partial-acs-import` gerçek ledger'da deterministik üretilemez — stub-only (v1).

### D) CI

Push/PR → `.github/workflows/localnet-drill.yml`:

1. **CLI tests + ACS fault drill** — `npm test` + `cli/scripts/fault-drill.sh`
2. **LocalNet 2-participant ping drill** — Canton OSS indir + `simple-ping.canton`

**Kapsam dışı (bilinçli):** UI, metrics dashboard, alerting platformu.

See [`cli/README.md`](cli/README.md) for full CLI reference.
