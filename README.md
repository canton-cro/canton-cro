# Canton CRO

Open-source CLI for **party/participant recovery orchestration** on Canton (offline party replication, backup validation, restore drills). No keys, no wallet, no dashboard.

## Status

| Piece | Path |
|-------|------|
| Proje rehberi (aşamalar + vibe-coding promptlar) | [`notes/canton-recovery-orchestration-rehber.html`](notes/canton-recovery-orchestration-rehber.html) |
| Manual baseline (13 steps) | [`docs/manual-baseline.md`](docs/manual-baseline.md) |
| Local 2-participant env | [`localnet/`](localnet/) |
| Happy-path CLI + fault drill | [`cli/`](cli/) |
| CI LocalNet / fault drill | [`.github/workflows/localnet-drill.yml`](.github/workflows/localnet-drill.yml) |

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

### D) CI

Push/PR → `.github/workflows/localnet-drill.yml`:

1. **CLI tests + ACS fault drill** — `npm test` + `cli/scripts/fault-drill.sh`
2. **LocalNet 2-participant ping drill** — Canton OSS indir + `simple-ping.canton`

**Kapsam dışı (bilinçli):** UI, metrics dashboard, alerting platformu.

See [`cli/README.md`](cli/README.md) for full CLI reference.
