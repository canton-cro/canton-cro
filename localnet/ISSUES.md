# Kurulum notları / kırılanlar

## 1) Splice LocalNet — BLOCKED

- **Ne denendi:** cn-quickstart / Docker Compose LocalNet
- **Kırılan:** `docker` komutu yok; Docker Desktop yok; WSL yüklü değil
- **Elle düzenlenen dosya:** yok (kuruluma geçilemedi)
- **Etki:** Splice 3-validator LocalNet bu makinede yok
- **Çözüm yolu:** Docker Desktop + WSL2 kur → sonra cn-quickstart `make setup && make start`
- **PoC etkisi:** Kritik değil — native 2-participant topoloji yeterli

## 2) Türkçe Windows locale — Kırıldı, düzeltildi

- **Belirti:** Participant start fatal:
  `IllegalArgumentException: non expected non first character 0x130 in Daml-LF Name "TİME"`
- **Neden:** TR locale `i` → `İ` (U+0130); Daml-LF identifier `TIME` bozuluyor
- **Elle düzenlenen dosya:** yok — runtime JVM flag
- **Fix:**
  ```
  JAVA_TOOL_OPTIONS=-Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8
  ```
  (`localnet/scripts/health-check.ps1` bunu set ediyor)

## 3) Config hand-wire

- **Durum:** Gerekmedi
- **Kullanılan:** `vendor/canton-open-source-3.5.8/examples/01-simple-topology/` (upstream, diff yok)
- canton-compose #93 senaryosu (custom multi-node HOCON) bu aşamada gerekmedi

## 4) JDK

- Sistemde Java 8 vardı (yetersiz)
- `winget install Microsoft.OpenJDK.17` ile 17.0.19 kuruldu

## 5) macOS iCloud Documents — Kırıldı, taşındı

- **Belirti:** `node`/`tsx` başlarken `Error: ETIMEDOUT: connection timed out, read` (errno -60, `readFileSync`)
- **Neden:** Repo `~/Documents` altındaydı; iCloud Drive "Desktop & Documents" senkronu `node_modules` dosyalarını buluta offload ediyor (dataless), okuma anında geri indiremeyince yerel `read` timeout'a düşüyor
- **Fix:** Repo iCloud kapsamı dışına taşındı (`~/dev/canton-cro`). Windows TR-locale mayınının (madde 2) macOS muadili
- **Etki:** Kod değişikliği yok; çalışma dizini kuralı: repo'yu iCloud-senkronlu klasörde tutma

## 6) Memory storage ACS import'u reddediyor — cro-topology.conf ile çözüldü

- **Belirti:** `IMPORT_ACS_ERROR ... is in memory which is not supported by repair. Use db persistence.`
- **Neden:** Canton, ACS import'u (repair sınıfı işlem) memory storage'da desteklemiyor — `01-simple-topology` party replication için yetersiz
- **Fix:** `localnet/cro-topology.conf` — participant'lar H2 file storage (`config/storage/h2.conf` mixin + `examples/07-repair` kalıbı), portlar simple-topology ile aynı
- **Detay:** `docs/manual-baseline-run-log.md`

## 7) Windows + Git Bash — DAR path JAVA_TOOL_OPTIONS içinde kırılıyor

- **Belirti:** `No such file [/c/Users/.../CantonExamples.dar]` (daemon ayağa kalkıyor, step0 fail)
- **Neden:** MSYS argv path dönüşümü `JAVA_TOOL_OPTIONS` içindeki `/c/...` yollarına uygulanmıyor; Windows Java bu yolu açamıyor
- **Fix:** `cli/scripts/live-drill.sh` / `live-fault-drill.sh` içinde `cygpath -m` ile native path (`C:/...`) verilmeli (yamasız tekrar koşum kırılır)

## 8) Windows — Node `bin/canton` spawn edemiyor

- **Belirti:** preflight `live probe failed (exit=spawn-error)`; probe log boş
- **Neden:** Unix shim `bin/canton`; Node Windows’ta bunu doğrudan exec edemez → `bin/canton.bat` + `shell: true` gerekir
- **Fix:** `cli/src/runner/canton.ts` → `resolveCantonExecutable()`

## 9) Windows — Scala script path’te `\` escape kırılıyor

- **Belirti:** `export_acs.sc: expected ([btnfr'\\\\\"]] | UnicodeEscape)` path `C:\Users\...`
- **Neden:** Scala string’de `\U` unicode escape
- **Fix:** `forScalaPath()` — script’e gömülen yollarda `/` kullan
