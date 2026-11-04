# Performans

DijiTerminal gün boyu ikinci monitörde açık kalır; izlediği Claude Code session'larından daha fazla kaynak yememeli. Bu sayfa bütçeyi ve ölçüm yöntemini özetler.

## Bütçe (referans: MacBook Pro M3, 18 GB)

| Metrik | Hedef | Ölçen komut |
|--------|-------|-------------|
| Boşta CPU (session yok, pencere görünür), toplam | < %1 | `npm run bench -- --idle` |
| 4 aktif session (replay ×5), main | < %5 | `npm run bench` |
| 4 aktif session, renderer (3B dahil) | < %15 | `npm run bench` |
| Pencere gizli, 4 aktif session, toplam | < %1 | `npm run bench:hidden` |
| Toplam bellek (`phys_footprint`, tüm süreçler), p95 | < 700 MB | `npm run bench` |
| Toplam RSS (main + renderer + GPU) | bilgi satırı | `npm run bench` |
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

**2026-11-05, MacBook Pro M3 Pro 18 GB, uygulama modu, Dengeli kalite**

| Metrik | Değer | Hedef |
|--------|-------|-------|
| 4 aktif session, main / renderer CPU | %0.2 / %1.7 | < %5 / < %15 ✓ |
| 3B harita, aktif | 60 fps | ≥ 50 ✓ |
| Snapshot (en büyük) | 77 KB | < 200 KB ✓ |
| İlk snapshot, 500 MB sentetik (`bench:big`) | 822 ms | < 1.5 sn ✓ |
| Toplam RSS p95 (bilgi) | 396 MB | — |
| Toplam bellek (`phys_footprint`) p95, 180 sn / 10 dk | 589 / 677 MB | < 700 MB ✓ |

Bellek kırılımı (footprint, 180 sn aktif): main 51 → 63 MB, renderer 82 → 184 MB (yükseliyor), **GPU 325–405 MB**, diğer 7 MB. GPU payı harita boştayken (4 fps, `bench:big`) de 335 MB; yani yükle değil WebGL çizim tamponlarıyla (Metal/IOSurface) ilgili sabit bir taban. Bu tamponlar RSS'te görünmez; bu yüzden eski RSS ölçümü belleği düşük gösteriyordu.

Bütçenin 350 → 700 MB'a çekilmesi (karar 2026-11-05), 45 sn'lik deneylere dayanıyor (GPU footprint):

| Varyant | GPU |
|---------|-----|
| Mevcut (Dengeli, antialias açık) | 380–395 MB |
| Antialias kapalı | ~360 MB |
| Piksel oranı 1 | ~413 MB (fark yok) |
| 3B harita hiç yok (liste) | ~250 MB |

GPU tabanının çoğu Chromium'un sayfa birleştirmesi; aynı Mac'te başka bir Electron uygulamasının GPU süreci 235 MB, Claude masaüstü 137 MB. 10 dk'lık koşuda renderer ~4. dakikada ~200 MB'ta, main ~65 MB'ta duruyor (sızıntı değil). Antialias'ı Dengeli'de kapatmak ~30 MB kazandırır ama kenarlar tırtıklanır ve kalite değişimi WebGL bağlamını yeniden kurmayı gerektirir; uygulanmadı.

Ölçü değişikliği: `footprint` aracı (`/usr/bin/footprint`) yalnızca `DIJI_PERF=1` açıkken 5 sn'de bir çağrılır; `[perf]` satırı ve rapor `footprintMb` + `footprintParts` (main/renderer/GPU/diğer) içerir. Bütçe satırı footprint'le değerlendirilir; RSS bilgi satırıdır, exit kodunu etkilemez.
