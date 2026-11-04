# Performans

DijiTerminal gün boyu ikinci monitörde açık kalır; izlediği Claude Code session'larından daha fazla kaynak yememeli. Bu sayfa bütçeyi ve ölçüm yöntemini özetler.

## Bütçe (referans: MacBook Pro M3, 18 GB)

| Metrik | Hedef | Ölçen komut |
|--------|-------|-------------|
| Boşta CPU (session yok, pencere görünür), toplam | < %1 | `npm run bench -- --idle` |
| 4 aktif session (replay ×5), main | < %5 | `npm run bench` |
| 4 aktif session, renderer (3B dahil) | < %15 | `npm run bench` |
| Pencere gizli, 4 aktif session, toplam | < %1 | `npm run bench:hidden` |
| Toplam RSS (main + renderer + GPU) | < 350 MB | `npm run bench` |
| İlk snapshot, 500 MB günlük transcript | < 1.5 sn | `npm run bench:big` |
| Snapshot boyutu | < 200 KB | `npm run bench` |
| 3B harita, görünür ve aktif | ≥ 50 fps | `npm run dev` + `?debug=1` (otomatik ölçüm yok, aşağıya bkz.) |
| 60 dk soak RSS artışı | < 40 MB | `npm run bench:soak` |
| Renderer bundle (ilk yüklenen JS) | 3B harita ayrı chunk | `npx electron-vite build` çıktısı |

CPU yüzdeleri Etkinlik Monitörü gibi tek çekirdek = %100 ölçeğindedir.

## Nasıl ölçülür

```sh
npm run build          # bench out/ yoksa kendisi derler
npm run bench          # Electron + 4 fixture ×5 replay, 120 sn
npm run bench:hidden   # 20. sn'de pencere gizlenir; gizli faz ayrı satır
npm run bench:big      # 500 MB sentetik günlük klasör (--mb ile değiştirilebilir), ilk snapshot
npm run bench:soak     # 60 dk; RSS 5 dk'lık kovalarda
npm run bench:headless # Electron/GPU olmadan yalnızca motor (CI, konteyner)
```

- Her şey geçici bir `CLAUDE_CONFIG_DIR`'de olur; gerçek `~/.claude` okunmaz. Uygulama ayrı bir userData ile açılır (`DIJI_USER_DATA`), açık DijiTerminal'le çakışmaz.
- Replay, fixture'ları döngüde oynatır: session'lar ve pid'ler aynı kalır, kayıt kimlikleri her döngüde değişir; fixture'lardaki dakikalık boşluklar en fazla 3 sn'ye sıkıştırılır. Yük, gerçek 4 session'dan ağırdır.
- Rapor `bench-results/<ISO>-<senaryo>-<mod>.json` (gitignore). Bütçe aşımında exit 1 yalnızca Apple M3'te ya da `--strict` ile; başka makinede tablo bilgi amaçlıdır.
- Uygulama içinde elle: `DIJI_PERF=1 npm run dev` → 10 sn'de bir konsola `[perf] cpu main … · renderer … · rss …` satırı; `DIJI_PERF_OUT=/tmp/perf.json` ile JSON rapor.
- FPS: `npm run dev` açıkken pencerede `?debug=1` (geliştirici araçlarında `location.search = '?debug=1'`) → haritanın sol altında fps, draw call, geometri/doku sayısı ve parçacık havuzu.

## Son ölçüm

**2026-10-28, konteyner (Intel Xeon 2.8 GHz, 2 çekirdek, Linux), `--headless`** — Electron/renderer/GPU yok, yalnızca motor; referans makine değil.

| Metrik | Değer | Hedef |
|--------|-------|-------|
| Boşta CPU (30 sn) | %0.8 | < %1 |
| 4 aktif session, main (görünür faz, ort. / p95) | %2.8 / %6.5 | < %5 |
| Gizli faz, 4 aktif session | %1.9 | < %1 ✗ |
| Motor RSS p95 | 77 MB | (toplam < 350 MB) |
| En büyük snapshot | 77 KB | < 200 KB |
| İlk snapshot, 500 MB sentetik | 1767 ms | < 1.5 sn ✗ (2 çekirdekli sunucu) |
| Renderer ilk JS | 1295 KB → 355 KB (3B harita 949 KB ayrı chunk, liste görünümünde hiç yüklenmez) | — |

Gizli fazdaki aşımın nedeni: motor `background` tempoda snapshot yayınını seyrekleştiriyor ama olay akışı (≈6 olay/sn) aynı kalıyor. Brief'teki "gizliyken yalnızca `status` olayları" kuralı motorda henüz yok. Mac ölçümü bekleniyor.

**Mac (M3) ölçümü:** henüz yok — `npm run bench`, `bench:hidden`, `bench:big`, `bench:soak` sonuçlarını buraya ekleyin.
