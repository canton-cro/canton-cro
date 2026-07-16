# Demo Video: Storyboard + Çekim Script'i

Hedef: 2-4 dakika, tek video. Akış birebir `cli/scripts/live-fault-drill.sh`:
taşı -> boz -> gerçek hata -> güvenli dur -> temizlik kanıtı -> restore ->
resume -> tamam. YENİ İDDİA YOK; ekranda ne varsa run log'da kanıtı var.

Dil: ekran metinleri (caption) İngilizce (reviewer kitlesi), anlatım istersen
sessiz + caption yeterli. Konuşacaksan kısa İngilizce cümleler kullan.

## Çekim öncesi hazırlık (bir kez yap)

1. `bash cli/scripts/live-drill.sh` ve `bash cli/scripts/live-fault-drill.sh`
   bir kez koş: Canton indirilmiş, npm cache dolu olsun. Çekimde bekleme olmaz.
2. Terminal: koyu tema, font 16pt+, pencere ~120 sütun. Prompt'u kısalt
   (uzun path gösterme).
3. İki terminal sekmesi: T1 = drill koşumu, T2 = kanıt dosyalarını gösterme
   (`cat`, `jq`).
4. Tarayıcıda hazır sekmeler: repo ana sayfa, Actions sayfası (3 yeşil job
   görünür halde), `docs/manual-baseline-run-log.md`.
5. Kayıt: tüm drill'i baştan sona kaydet, hızlandırmayı kurguda yap
   (bekleme bölümleri 8-16x). Kesme yok, tek çekim + hız ayarı en inandırıcısı.

## Sahneler

### Sahne 1 (0:00-0:20) Problem

- Ekran: `docs/manual-baseline.md` açık, 13 adımlık "Referans sıra" bölümünde
  yavaş scroll.
- Caption: "Party replication on Canton is a 13-step manual console
  procedure." ardından "One mistake mid-import can leave a participant in a
  broken state."
- Not: docs.digitalasset.com sayfasını da 2 sn gösterebilirsin (prosedürün
  resmi olduğu anlaşılsın).

### Sahne 2 (0:20-0:50) Happy path, tek komut

- T1: `bash cli/scripts/live-drill.sh` (kayıttan hızlandırılmış).
- Ekranda durulacak anlar (hızı düşür):
  - `preflight: PASS` ve üstündeki `probe: live probe ok` satırı
  - 13 yeşil adım akarken kısa bekle; `export_acs wrote ... bytes` satırı
  - `already complete (idempotent no-op)` (ikinci apply)
  - `CRO_ASSERT_OK`
- Caption: "13 real steps, one command. Re-running is a safe no-op."

### Sahne 3 (0:50-1:10) Ölü ortam asla yeşil değil

- T1: daemon kapalıyken `... preflight --run <id>` (ya da önceden alınmış
  kayıt).
- Ekranda: `treating environment as DOWN (all probed facts false)` ve
  `preflight: FAIL` + `[ERR] participants_reachable`.
- Caption: "Preflight probes the live environment. A dead environment never
  looks green."

### Sahne 4 (1:10-2:30) ANA SAHNE: kır, teşhis et, kurtar

- T1: `bash cli/scripts/live-fault-drill.sh` (hızlandırılmış; aşağıdaki
  anlarda normal hız).
- Durulacak anlar, sırayla:
  1. `SAFE STOP at import_acs (PROTO_DESERIALIZATION_FAILURE)` satırı.
     Caption: "The snapshot is deliberately corrupted. Canton rejects it
     for real. The tool stops safely: no reconnect, no flag clearance."
  2. T2: `jq . cli/runs/ci-fault-a8/diagnosis.json` (veya fault-a8). Şu
     alanlarda 2-3 sn bekle: `observed` (gerçek GrpcClientError satırı),
     `doNot`, `nextActions`. Caption: "Real error lines, what NOT to do,
     and the recovery path."
  3. T1: `CRO_CLEAN_OK` satırı. Caption: "Proof the failed import left
     nothing behind: the target ACS is empty. Retry is safe."
  4. T1: `rollback done: snapshot restored, fault disarmed`.
  5. T1: `run ...: completed` ve `CRO_ASSERT_OK`. Caption: "Restore the
     pristine snapshot, resume, and the replication completes. The target
     now sees the party's contracts."
- İsteğe bağlı tek cümle caption (kapanışa köprü): "This drill once caught a
  real bug in our own resume logic. That is why drills exist."

### Sahne 5 (2:30-2:50) Her push'ta kendini kanıtlıyor

- Ekran: GitHub Actions sayfası, 3 yeşil job; `REAL broken-ACS drill` job'ına
  tıkla, artifact listesini (diagnosis/state/events) 2 sn göster.
- Caption: "The full break/restore/resume cycle runs in CI on every push."

### Sahne 6 (2:50-3:10) Kapanış

- Ekran: README üstü (License: Apache-2.0 satırı görünsün) + repo URL.
- Caption üç satır, sırayla:
  - "No keys. No wallet. No dashboard. Recovery orchestration only."
  - "Apache-2.0. Evidence for every claim in the repo."
  - "github.com/emrhnyz/canton-cro"

## Kurgu notları

- Toplam 3:10 hedefle; 4:00'ı geçme.
- Hata/bekleme anlarını atla ama SAFE STOP ve diagnosis sahnesini ASLA
  hızlandırma; videonun kalbi orası.
- Müzik gerekmez; koyarsan çok kısık tut.
- Yükleme: YouTube (unlisted yeterli) veya repo release asset; linki README'nin
  "Demo video" bölümüne koy.
