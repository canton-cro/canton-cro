# Canton Recovery Orchestration — Agent Handoff (v2)

**Tarih:** 2026-07-16
**Amaç:** Bu dosyayı yeni bir agent'a vererek projeyi **aynı bağlam seviyesinde** devam ettirmek.
**Dil:** Kullanıcı Türkçe konuşuyor; teknik terimler İngilizce kalabilir.
**Repo:** https://github.com/emrhnyz/canton-cro (public)
**Rehber (aşamalar + prompt setleri):** `notes/canton-recovery-orchestration-rehber.html` — durum banner'ı ve promptlar 2026-07-16 itibarıyla güncel.

---

## 1) Proje tek cümle

Canton Network Development Fund için başvurulacak açık kaynak **CLI / ops aracı**: party/participant **taşıma + yedek doğrulama + felaket tatbikatı (restore drill)** orchestration'ı. Key/seed export yok. SDK değil. Cüzdan değil. DEX değil. Zorunlu ürün sitesi yok.

**Grant cümlesi:**
> Canton'da party/participant recovery hâlâ manuel; biz key'e dokunmadan dry-run migration, backup doğrulama ve restore drill sunan open-source orchestration CLI getiriyoruz.

**v2 farkı:** Bu artık plan değil, ÇALIŞAN ve KANITLI bir PoC. 13 adım gerçek Canton 3.5.8'de uçtan uca koşuyor; preflight canlı probe'larla; fault drill gerçek hata üretip gerçek kurtarma yapıyor; CI'da 3 job yeşil.

---

## 2) DURUM (2026-07-16) — önce bunu oku

| Aşama | Durum | Kanıt |
|-------|-------|-------|
| Fikir seçimi | ✅ Recovery Orchestration kilit | — |
| CWIF | ❌ Ölü — geri dönme | — |
| 0A DA roadmap | ✅ Not edildi (release notes'ta party-level iz yok; yazılı teyit A5 öncesi opsiyonel) | — |
| 0B 2-participant ortam | ✅ **H2 kalıcı topoloji** (memory YETMEZ — aşağıda) | `localnet/cro-topology.conf` |
| A1/A1b Manuel baseline | ✅ GERÇEK koşuldu, karar **GO** | `docs/manual-baseline-run-log.md` |
| A2-A4 CLI iskeleti | ✅ (stub artık sadece test fallback) | `cli/src/` |
| **A6 Canton adapter** | ✅ 13/13 gerçek adım + idempotent no-op + hedefte ACS assert | `runner/canton.ts`, `live-drill.sh`, run-log A6 |
| **A7 Live preflight** | ✅ 7 canlı probe; ölü ortam fail-safe FAIL → apply bloke | `runner/probe.ts`, run-log A7 eki |
| **A8 Gerçek fault drill** | ✅ boz → GERÇEK hata → diagnosis → temiz-hedef kanıtı → restore → resume → tamam | `live-fault-drill.sh`, run-log A8 eki, `localnet/out/fault-a8-diagnosis.json` |
| CI | ✅ 3 job yeşil (stub drill / ping / **gerçek fault drill**, artifact'lı) | `.github/workflows/localnet-drill.yml` |
| Unit testler | ✅ 23/23 | `cli/src/*.test.ts` |
| **A9 Demo + threat-model + runbook** | 🟡 Dokümanlar ✅ (`docs/threat-model.md`, `docs/runbook.md`, `docs/demo-video-storyboard.md`); **video ÇEKİMİ kaldı** (insan işi) | README "Demo video" bölümü |
| **A5 Grant proposal PR** | ⬜ **SIRADAKİ AGENT İŞİ** (videoyla paralel yürüyebilir) | rehber Prompt A5 |
| Champion süreci | ⬜ Kullanıcı ayrıca yürütüyor (PR → needs-champion) | — |

**Sıradaki iş sırası:** (insan) videoyu storyboard'a göre çek + linki README'ye koy || (agent) A5 grant metni (AI-slop kurallarıyla, outline → onay → full) → PR → needs-champion.
**Ayrıca:** arkadaş (emrhnyz) Windows uyumluluğunu doğrulayıp düzeltti (canton.bat resolve, cygpath native path, Scala path escape — `localnet/ISSUES.md` #7-9) ve Apache-2.0 LICENSE + NOTICE ekledi.

---

## 3) KRİTİK TEKNİK KEŞİFLER — yeni agent bunları bilmeden kod yazmasın

1. **Memory storage ACS import'u REDDEDIYOR:** `IMPORT_ACS_ERROR ... is in memory which is not supported by repair. Use db persistence.` → `01-simple-topology` party replication için YETERSİZ. Çözüm: `localnet/cro-topology.conf` (participant'lar H2 file storage, `config/storage/h2.conf` mixin ile; sequencer/mediator memory kalabilir). Portlar simple-topology ile aynı.
2. **`import scala.util.Try` Canton 3.5.8 console'unda patlıyor** (Scala 2 REPL, TASTy hataları). Console script'lerinde `scala.util._` import ETME; saf `try/catch` kullan.
3. **`resume` config.json'ı reload eder** (A8'de bulunan bug'ın fix'i): state.config apply anının snapshot'ı; kurtarma sırasında (örn. faultInjection=none edildikten sonra) resume güncel config'i okur. Bu davranışı bozma.
4. **partial-acs-import gerçek ledger'da deterministik üretilemez** → v1'de bilinçli stub-only. Grant metninde SADECE broken-snapshot drill'i gerçek diye anlat; iddia büyütme.
5. **Ortam mayınları:** (a) TR-Windows locale `TİME` fatal'ı → `JAVA_TOOL_OPTIONS=-Duser.language=en -Duser.country=US` (runner otomatik ekler); (b) macOS'ta repo `~/Documents` altında OLMAMALI — iCloud senkronu node_modules'ı offload edip `ETIMEDOUT errno -60` üretiyor (repo bu yüzden `~/dev/canton-cro`'ya taşındı); (c) `JAVA_TOOL_OPTIONS` içinde boşluklu path → `-D` değerini çift tırnakla. Detay: `localnet/ISSUES.md` (6 madde).
6. **Adapter mimarisi:** uzun ömürlü daemon (`bootstrap-daemon.canton`, `CRO_DAEMON_READY` marker) + adım başına kısa ömürlü remote console script (`localnet/remote-topology.conf`). Adımlar arası değerler (`beforeActivationOffset`, `targetLedgerEnd`) script stdout'undaki `CRO_VAR key=value` satırlarıyla taşınır → `runs/<id>/vars.json`.

---

## 4) Ne yapıyoruz / ne değil (kapsam duvarı — değişmedi)

### Yaptık (kanıtlı)
- Offline party replication orchestration'ı (13 adım, gerçek)
- `plan` (dry-run) / `preflight` (CANLI probe) / `apply` / `resume` (idempotent, config-reload'lu)
- Post-condition doğrulama (export boyutu, hedef ACS assert)
- GERÇEK bozuk ACS import tatbikatı + rollback prosedürü (run-log A8'de runbook özeti)
- CI'da koşan drill'ler; Apache-2.0 uyumlu açık kaynak yapı

### Yapmıyoruz (bozma)
- Key / mnemonic / seed export (CWIF öldü)
- Cüzdan / dApp UI / dashboard / observability platformu (COOT tuzağı)
- Hard domain / synchronizer migration (LSU alanı; #294 öldü)
- Party offboarding (protokolde yok)
- Decentralized party membership (Decentralization Manager'ın işi)

---

## 5) Repo haritası (2026-07-16)

```
canton-cro/
├── README.md                      # kanıt adımları A-D (C2: live drill, C3: gerçek fault drill)
├── docs/
│   ├── manual-baseline.md         # 13 adım spec (KOŞULDU)
│   └── manual-baseline-run-log.md # GERÇEK koşum kayıtları: ana + A7 eki + A8 eki; GO kararı
├── cli/src/
│   ├── index.ts                   # init/plan/preflight/apply/resume/status/drill
│   ├── machine.ts                 # state machine, safe stop, runner seçimi
│   ├── preflight.ts / facts.ts    # kurallar + probe merge (probe damgalı facts.json)
│   ├── fault.ts                   # stub + GERÇEK diagnosis üreticileri
│   └── runner/{stub,canton,probe}.ts
├── cli/scripts/
│   ├── live-drill.sh              # A6 kanıtı: 13 gerçek adım uçtan uca
│   ├── live-fault-drill.sh        # A8 kanıtı: kır→teşhis→restore→resume
│   └── fault-drill.sh             # stub drill (CI)
├── localnet/
│   ├── cro-topology.conf          # H2 kalıcı topoloji (ZORUNLU)
│   ├── remote-topology.conf, bootstrap-daemon.canton
│   ├── scripts/*.sc               # step0-setup, final-assert, assert-clean-target
│   ├── ISSUES.md                  # 6 ortam sorunu + fix
│   └── out/                       # kanıt dosyaları (live-*, fault-*)
├── .github/workflows/localnet-drill.yml  # 3 job (hepsi yeşil)
└── notes/                         # rehber HTML + bu handoff
```

**Kanıt dosyaları (grant/video için):** `localnet/out/live-drill-proof.txt`, `live-a6-state.json`, `live-a6-events.jsonl`, `live-a7-facts.json` (probe damgalı), `fault-a8-diagnosis.json` (gerçek Canton hatası), `fault-drill-proof.txt` + CI artifact'ları.

---

## 6) Çalışma düzeni (iki makine + kimlikler)

- **Kullanıcı (mac):** repo `/Users/erenyegit/dev/canton-cro` (iCloud dışı — taşıma sebebi keşif #5b). Git kimliği repo-local **cleron43** (noreply email); gh CLI'da cleron43 aktif hesap, erenyegit yedekte (`gh auth switch`). OpenJDK 17 Homebrew'da: `export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"`.
- **Arkadaş (Windows, emrhnyz):** repo sahibi; TR locale fix'i şart (ISSUES.md #2). Windows'ta live-drill henüz doğrulanmadı (opsiyonel iş #5, rehber bölüm 6).
- **Commit kuralı:** commit mesajlarına Co-Authored-By / AI imza satırı EKLEME.
- **Akış:** doğrudan main'e push (PR akışı bilinçli olarak kullanılmıyor — kullanıcı kararı).
- Canton OSS 3.5.8 `vendor/` altında (gitignore'lu; script'ler yoksa otomatik indirir).

---

## 7) Karar geçmişi (özet)

1. Klasik crypto fikirleri (DEX, NFT, payroll...) elendi — fon common good istiyor, raflar dolu.
2. **DeFi aggregator SDK** → reddedildi (Rubic #483 champion'lı rakip, OneSwap #183 canlı üründe bile öldü, DeFi rafı mezarlık).
3. **CWIF** (wallet interchange) → öldürüldü: Canton external party'de key kullanıcıda, BIP-39 mnemonic zaten taşınabilirlik sağlıyor; key export kurumsalda anti-pattern.
4. **Recovery Orchestration** seçildi (skor 5.5/10 ile en yüksek). Bant: **400-650k CC, 3 milestone** (1.2M tavanına çıkma).
5. A6+A7+A8 tek günde (2026-07-16) tamamlandı; iki gerçek keşif (memory-storage, TASTy) ve bir gerçek bug (resume config reload) koşumda bulundu.
6. Rakip/çakışma bağlamı: COOT #433 (kapsam şişkin + champion apatisi ile öldü — bizim farkımız çalışan kanıt), Migration Lens #34 (dar, ilgisiz kaldı), Decentralization Manager #298/#530 (komşu ama farklı iş), Hard Migration #294 (LSU tarafından gereksizleşti — DA roadmap sorusunun sebebi).

---

## 8) Grant programı — linkler (değişmedi)

| Ne | Link |
|----|------|
| Grants program | https://canton.foundation/grants-program/ |
| Başvuru reposu | https://github.com/canton-foundation/canton-dev-fund |
| Proposal template | https://github.com/canton-foundation/canton-dev-fund/blob/main/proposals/_template.md |
| Review process | https://github.com/canton-foundation/canton-dev-fund/blob/main/Development%20Fund%20Proposal%20Review%20Process.md |
| SIG directory | https://github.com/canton-foundation/canton-dev-fund/blob/main/sig-directory.md |
| Lifecycle board | https://github.com/orgs/canton-foundation/projects/3/views/1 |
| CIP-0082 / CIP-0100 | https://github.com/canton-foundation/cips/blob/main/cip-0082/cip-0082.md · .../cip-0100/cip-0100.md |
| Mail | dev-fund@canton.foundation · grants-discuss@lists.sync.global |

**Başvuru şekli:** Web formu yok. Fork → `proposals/<name>.md` → PR `Proposal: <Name>`. Ödeme milestone bazlı CC.

**AI-slop bot (`aipricheck.yml`):** em-dash (—) yok; madde satırı `;` ile bitmez; uydurma jargon yok (sharding, Canton chain, Daml VM...); abartı kalıp yok. Proposal yazarken ZORUNLU.

**Party replication docs (3.5):** https://docs.digitalasset.com/operate/3.5/howtos/operate/parties/party_replication.html — 13 adımın kaynağı; imzalar canlı koşumla teyitli.

---

## 9) Fail testleri — güncel durum

1. DA "biz yapıyoruz" derse → bırak. **Durum:** release notes temiz; yazılı teyit opsiyonel.
2. Manuel akış ~20 satırla çözülüyorsa → değer yok. **Durum:** dürüstçe cevaplandı (run-log): happy path script'lenir; değer preflight+resume+safe-stop+drill demetinde. **GO.**
3. Broken ACS drill üretilemiyorsa → wrapper itirazı haklı. **Durum:** GEÇİLDİ — gerçek hata (`PROTO_DESERIALIZATION_FAILURE`) + gerçek kurtarma, CI'da tekrarlanabilir.
4. Kapsam dashboard'a şişerse → COOT. **Durum:** duvar korunuyor; A9'da da geçerli.

---

## 10) Yeni agent'a talimat

1. Bu handoff + rehberi (`notes/canton-recovery-orchestration-rehber.html`) oku; rehberin durum banner'ı ve Prompt A9 güncel.
2. Kullanıcıya sormadan CWIF / DEX / cüzdan / dashboard'a sapma; kapsam duvarına uy.
3. **Sıradaki iş A9** (video storyboard + threat-model.md + runbook.md) — YENİ İDDİA ÜRETME, mevcut kanıtları anlat. Sonra A5 (grant metni; AI-slop kurallarına uy; outline → onay → full).
4. Console script'i yazacaksan keşifler bölümünü (3) önce oku: scala.util yok, H2 zorunlu, CRO_VAR düzeni.
5. Doğrulama komutları: `cd cli && npm ci && npm test` (23/23 beklenir); canlı kanıt için `bash cli/scripts/live-drill.sh` ve `bash cli/scripts/live-fault-drill.sh` (JDK 17 gerekir; Canton otomatik iner).
6. Commit'lerde AI imza/trailer yok; push doğrudan main'e; mac'te kimlik cleron43.
7. Grant PR'ını A9 bitmeden zorlamaya çalışma; champion sürecini kullanıcı yürütüyor.
