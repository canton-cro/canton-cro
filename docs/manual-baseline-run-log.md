# Manuel baseline koşum kaydı — Offline party replication (GERÇEK Canton)

**Tarih:** 2026-07-16
**Ortam:** macOS (Apple Silicon), Canton OSS **3.5.8**, OpenJDK 17.0.19
**Topoloji:** `localnet/cro-topology.conf` (2 participant, **H2 file storage**) + `config/storage/h2.conf` mixin
**Koşum şekli:** 13 adım, `cli/scripts/live-drill.sh` ile CRO canton runner üzerinden — her adım
gerçek remote console script'i olarak koştu (stub yok). Adım script'leri ve ham loglar:
`cli/runs/live-a6/{scripts,logs}/`, kanıt kopyaları `localnet/out/live-*`.

> Not (A1b ↔ A6): baseline'ın "elle koş" hedefi, adapter geliştirmesiyle birleşti — her adım
> gerçek console'da tek tek koşturulup doğrulandı; farkı, komutların bir state machine'in
> içinden geçmesi. Aşağıdaki tablo adım adım GERÇEK çıktıları veriyor.

---

## Sonuç önce: GO

- 13 adımın tamamı gerçek Canton'da uçtan uca geçti (`run live-a6: completed`).
- İkinci `apply` idempotent no-op; final assert: **target participant party'nin contract'ını
  gerçekten görüyor** (`targetAcsCount=1`, `CRO_ASSERT_OK`).
- Baseline'daki 3.5 komut imzalarının tamamı doğrulandı — imza sapması çıkmadı.
- Kritik keşif (aşağıda): memory storage ACS import'u hiç desteklemiyor; bu, otomasyonun
  preflight değerini tek başına kanıtlayan türden bir tuzak.

---

## Adım adım gerçek çıktılar (run: live-a6)

| # | Adım | Sonuç | Gerçek çıktı / kanıt |
|---|------|-------|----------------------|
| 0 | Senaryo önkoşulu | OK | `step0-setup.sc`: party `alice-14598::12205b21...`, self-Iou create, `sourceAcsCount=1` |
| 1 | vet_packages | OK | Target'a CantonExamples upload; vetted listesinde target var; `mainPackageId=4dffebf4008e...` |
| 2 | data_retention | OK | `get_schedule()` boş (H2 localnet default'u schedule'sız); `pruningCleared=true` |
| 3 | target_authorize | OK | `propose_delta(..., requiresPartyToBeOnboarded = true)` imzalı transaction döndü |
| 4 | disconnect_all | OK | `list_connected()` boş — target izole |
| 5 | disable_auto_reconnect | OK | `modify(alias, _.copy(manualConnect = true))` |
| 6 | source_authorize | OK | `beforeActivationOffset=28` (`ledger_api.state.end()`), delta imzalandı |
| 7 | export_acs | OK | `export_party_acs(... beginOffsetExclusive=28L ...)` → **611 byte** `party_replication.acs.gz` |
| 8 | reenable_pruning (opt) | NO-OP | Geri yüklenecek schedule yoktu (adım 2 kaydı) |
| 9 | backup_target | SKIPPED (dokümante) | H2'de v1 no-op; gerçek backup+restore A8 kapsamı (aşağıdaki keşfe bak) |
| 10 | import_acs | OK | `import_party_acs(synchronizerId, party = Some(...), importFilePath = ...)` — 3.5 imzası doğru |
| 11 | reconnect | OK | `targetLedgerEnd=24`; `reconnect_local(alias)` → true |
| 12 | reenable_auto_reconnect (opt) | OK | `manualConnect = false` geri alındı |
| 13 | clear_onboarding_flag | OK | `clear_party_onboarding_flag` retry döngüsü → `FlagNotSet` |
| — | Final assert | OK | Target: `parties.list` party'yi görüyor + `acs.of_party` = 1 contract; source ACS'i korunuyor (replication ≠ migration) |

Idempotency kanıtı: ikinci `cro apply --run live-a6` → `already complete (idempotent no-op)`.

---

## Kritik keşif: memory storage ACS import'u desteklemiyor

İlk canlı koşum `01-simple-topology` (memory storage) ile yapıldı. 9 adım geçti,
**adım 10 Canton tarafından reddedildi** — birebir hata:

```
GrpcClientError: INVALID_ARGUMENT/IMPORT_ACS_ERROR(8,0e999dc0):
local::1220873c...::35-0 is in memory which is not supported by repair. Use db persistence.
```

Sonuçlar:

1. `01-simple-topology` party replication PoC'si için **yetersiz** — happy path'in kendisi
   kalıcı storage istiyor (sadece backup değil). Baseline adım 9/10'daki
   "bilinmiyor / doğrulanacak" boşluğu böylece kapandı.
2. Çözüm: `localnet/cro-topology.conf` — participant'lar H2 file storage
   (`examples/07-repair` kalıbı, Docker'sız). Sequencer/mediator memory kalabiliyor.
3. Bu tuzak, preflight'ın değerini kanıtlıyor: `storageKind` kontrolü artık gerçek bir
   arıza moduna karşılık geliyor (A7'de canlı probe'a bağlanacak).

## Doğrulanan diğer "bilinmiyor" maddeleri

- **Adım 4 assert'i:** `target.synchronizers.list_connected()` boş liste — çalışıyor.
- **Adım 7 assert'i:** export dosyası varlık + boyut (611 byte) TS tarafında assert edildi.
- **Adım 10 (3.4 vs 3.5):** 3.5 imzası (`synchronizerId` + `party` + `importFilePath`) doğru.
- **Adım 13:** dönüş değeri toString'i `FlagNotSet` içeriyor; retry ~ilk denemede geçti.
- **Beklenen gürültü:** happy path koşumunda ACS commitment mismatch uyarısı gözlenmedi
  (küçük/tek contract'lık ACS; büyük ACS'lerde beklenti baseline'daki gibi).

## Ortam mayınları (tekrarlanabilirlik notları)

- **macOS + iCloud:** Repo `~/Documents` altındayken iCloud Drive senkronu `node_modules`
  dosyalarını buluta offload edip yerel okumaları `ETIMEDOUT (errno -60)` ile kırıyor.
  Çözüm: repo iCloud kapsamı dışında bir dizinde tutulmalı (örn. `~/dev`). Windows'taki
  TR-locale mayınının (bkz. `localnet/ISSUES.md`) macOS muadili bu.
- **JAVA_TOOL_OPTIONS + boşluklu path:** `-D` değerlerinde boşluklu yol varsa çift tırnak
  şart (`"-Dcro.dar=/path with space/x.dar"`), yoksa JVM argümanı bölüyor.

---

## "20 satırlık script yeter mi?" fail testi — açık cevap

**Happy path, evet, ~15 console satırına sığar** (adım script'lerinin toplamı da aşağı
yukarı bu). Otomasyonun değeri happy path'i sarmakta DEĞİL; koşumun kendisinin
gösterdiği şu katmanlarda:

1. **Preflight**: memory-storage tuzağı gibi, adım 10'da 40 dakika sonra patlayan hatayı
   0. dakikada yakalamak (`storageKind`, bağlantı, vetting, flag kontrolleri).
2. **Sıra + değer taşıma**: `beforeActivationOffset` (adım 6→7) ve `targetLedgerEnd`
   (11→13) elle taşınıyor; sırayı bozan operatör docs'un "significant manual correction"
   bölgesine düşüyor.
3. **Resume/idempotency**: yarıda kalan koşumda "hangi adımda kalmıştım, tekrar koşmak
   güvenli mi" sorusunun cevabı script'te yok, state machine'de var.
4. **Güvenli durma**: import yarıda kaldığında reconnect'e devam ETMEMEK kritik
   (drill'in konusu — A8'de gerçek fault ile).

**Karar: GO** — otomasyon değeri var; iddia "wrapper" değil, preflight + resume +
post-condition + drill demeti.

---

## Sıradaki işler (A7/A8 girdileri)

- A7: preflight probe'ları gerçek Canton'dan oku (`storageKind`, `list_connected`,
  vetting, party hosting) — bu koşumun script'leri probe'ların hazır tarifi.
- A8: H2 dosya kopyasıyla gerçek backup → kasıtlı yarım/bozuk import → gerçek
  `ACS_COMMITMENT_MISMATCH`/`IMPORT_ACS_ERROR` yakala → backup'tan restore → resume.

---

# Ek: A7 koşum kaydı — Live preflight probe'ları (2026-07-16)

**Değişiklik:** `runner = canton` iken preflight, facts.json'daki beyan yerine tek bir remote
console koşumuyla ortamı gerçekten yokluyor (`cli/src/runner/probe.ts`). Probe edilebilen 7
gerçek: participant health, cross-ping, party source'ta hosted, **party target'ta zaten hosted
mı** (yeni uyarı), DAR varlığı, target synchronizer bağlantısı, party ACS'i dolu mu.
Operatör niyeti kalanlar (backupPlanReady, willSetOnboardingFlag, storageKind) beyan olarak
kalıyor; birleşik sonuç probe damgasıyla facts.json'a geri yazılıyor (denetlenebilir).

## Kanıtlar

- **Pozitif (run live-a7):** `probe: live probe ok` → `preflight: PASS` → 13/13 adım →
  idempotent no-op → `CRO_ASSERT_OK`. Probe'lu facts: `localnet/out/live-a7-facts.json`
  (`partyAlreadyOnTarget=false` — preflight anında replication henüz yapılmamıştı, doğru).
- **Negatif (daemon kapalı):** `live probe failed ... treating environment as DOWN (all
  probed facts false)` → `preflight: FAIL` → `participants_reachable` ERR → apply bloke.
  Ölü ortam asla yeşil görünmüyor (fail-safe).
- Testler: 20/20 (probe parse/merge, fail-safe, dead-console'da apply'ın hiç adım
  koşturmadan bloke olması, yeni warn check).

## Koşumda yakalanan gerçek sapma

- `import scala.util.Try` Canton 3.5.8 console REPL'inde patlıyor:
  `error while loading ... Add -Ytasty-reader to scalac options` (Scala 2 REPL,
  scala/util TASTy dosyalarını okuyamıyor). Çözüm: import'suz `try/catch`
  (`def safely(body: => Boolean)`). A6 adım script'lerinde bu import olmadığı için
  görünmemişti — console script'lerinde `scala.util._` import'undan kaçının.
- `parties.hosted(filterParty = ...)` 3.5.8'de doğrulandı (source true / target false,
  replication sonrası target true).

---

# Ek: A8 koşum kaydı — GERÇEK broken-ACS drill (2026-07-16)

**Değişiklik:** Fault artık simülasyon değil. `--fault broken-acs-import` + canton runner:
import öncesi export snapshot'ının pristine kopyası (`*.good`) alınır, canlı dosya
deterministik bozulur (ilk yarı + sabit junk) ve import GERÇEK Canton tarafından reddedilir.
`partial-acs-import` gerçek ledger'da deterministik üretilemiyor — v1'de açıkça stub-only
(iddia büyütme yok).

## Uçtan uca kanıt (run: fault-a8, `cli/scripts/live-fault-drill.sh`)

1. **Gerçek kırılma:** Canton'ın verdiği hata birebir:
   `GrpcClientError: INVALID_ARGUMENT/PROTO_DESERIALIZATION_FAILURE(8,...): Deserialization of protobuf message failed`
2. **Güvenli durma:** `SAFE STOP at import_acs (PROTO_DESERIALIZATION_FAILURE)` —
   `import_acs=failed`, `reconnect`/`clear_onboarding_flag` pending kaldı (ileri atlama yok).
3. **Anlamlı diagnosis:** `diagnosis.json` gerçek hata satırları + gerçek kod + rollback
   adımları içeriyor (`localnet/out/fault-a8-diagnosis.json`).
4. **Temiz-hedef kanıtı:** `assert-clean-target.sc` → `targetAcsCountAfterFail=0`,
   `CRO_CLEAN_OK` — failed import hiçbir contract'ı yarım bırakmadı; restore+retry güvenli.
5. **Rollback:** pristine snapshot geri kondu, `faultInjection=none` yapıldı.
6. **Kurtarma:** `cro resume` → import restore edilmiş dosyayla geçti → kalan adımlar →
   `run fault-a8: completed` → `CRO_ASSERT_OK` (target'ta party ACS'i canlı).

## Güvenli dur / rollback prosedürü (operatör runbook özeti)

```
FAILED import_acs gördüğünde:
1. DURMA doğru davranış — reconnect etme, onboarding flag'i temizleme.
2. runs/<id>/diagnosis.json oku (gerçek Canton hatası + kod).
3. Hedef temiz mi doğrula: assert-clean-target.sc (target ACS boş olmalı).
4. Snapshot'ı restore et: cp party_replication.acs.gz.good party_replication.acs.gz
5. runs/<id>/config.json -> faultInjection: "none" (drill ise).
6. cro resume --run <id>  -> kaldığı adımdan tamamlar.
```

## Koşumda bulunan ve düzeltilen gerçek bug

`cro resume`, config.json'ı yeniden okumuyordu — state içindeki config snapshot'ı
(fault=broken) ile devam edip snapshot'ı TEKRAR bozuyordu. Kurtarma döngüsü bu yüzden
resume'a config reload eklenerek düzeltildi (`cli/src/index.ts`). Bu, fault drill'in
kendisinin yakaladığı gerçek bir orchestration hatası — drill'lerin varlık sebebi.

## CI

`.github/workflows/localnet-drill.yml` -> `live-fault-drill` job'ı: her push/PR'da
gerçek kır-restore-resume döngüsünü koşar, diagnosis/state/events'i artifact yükler.
