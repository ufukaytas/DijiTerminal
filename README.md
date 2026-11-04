# DijiTerminal

iTerm2'de paralel çalışan Claude Code session'larını ikinci monitörden takip etmek için macOS uygulaması.

## Durum

| Faz | İçerik | Durum |
|-----|--------|-------|
| 1 | iTerm2 sekme trafik ışığı, uygulamasız bildirimler, hook/statusLine kurulumu (`hooks/`) | Çalışıyor |
| 2 | Electron uygulaması: motor, 3B harita, paneller, iTerm2'ye gitme, bildirimler, ayarlar, paketleme | 0.1.0 (MVP) |
| 3 | Menü çubuğu modu, robot ekipleri, gömülü terminal (arka plan session'ları) | 0.2.0 — bkz. [CHANGELOG.md](CHANGELOG.md) |
| — | Mobil, analizler, diğer terminaller… | Backlog |

## Uygulamayı kurma

1. [Releases](../../releases) sayfasından Mac'inize uygun `.dmg`'yi indirin: `arm64` (Apple Silicon) ya da `x64` (Intel). Açın, DijiTerminal'i **Applications** klasörüne sürükleyin. Sürümler Developer ID ile imzalı ve Apple tarafından notarize edilmiştir; Gatekeeper uyarısı çıkmaz.
2. İlk "iTerm2 sekmesine git" tıklamasında macOS iTerm2'yi kontrol izni ister → **İzin Ver**. Reddettiyseniz: Sistem Ayarları › Gizlilik ve Güvenlik › Otomasyon › DijiTerminal › iTerm (`tccutil reset AppleEvents com.dijitalai.dijiterminal` ile sıfırlanır).
3. Ayarlar (⌘,) › "Girişte başlat": oturum açınca uygulama penceresiz başlar (Dock'ta durur, motor ve bildirimler çalışır); Dock ikonuna tıklayınca pencere açılır. macOS bazen Sistem Ayarları › Genel › Giriş Öğeleri'nde onay ister.
4. Uygulama App Sandbox dışında çalışır (bilinçli karar): `~/.claude`'u salt okunur izler ve iTerm2'ye odaklanmak için `osascript` çalıştırır. Ağ erişimi ve otomatik güncelleme yoktur. Bu yüzden Mac App Store'da değil, doğrudan dağıtılır.

### Kendiniz derlerseniz

`npm run dist` → `release/DijiTerminal-<sürüm>-arm64.dmg` ve `-x64.dmg`. Bu build ad-hoc imzalıdır ve notarize değildir: ilk açılışta macOS "geliştirici doğrulanamadı" der → Applications'ta **sağ tık → Aç → Aç** (olmazsa Sistem Ayarları › Gizlilik ve Güvenlik › "Yine de Aç"). Ad-hoc her yeni build'de Otomasyon izni yeniden sorulabilir.

### İmzalı ve notarize sürüm alma

Gerekenler: keychain'de **Developer ID Application** sertifikası ve bir App Store Connect API anahtarı (`.p8`). Notarization kimlik bilgileri bir kez keychain'e kaydedilir, ortam değişkenlerinde sır tutulmaz:

```sh
xcrun notarytool store-credentials dijiterminal \
  --key ~/.private_keys/AuthKey_<KEY_ID>.p8 --key-id <KEY_ID> --issuer <ISSUER_ID>

CSC_NAME="Developer ID Application: <Ad Soyad> (<TEAM_ID>)" \
APPLE_KEYCHAIN_PROFILE=dijiterminal \
npm run dist:signed
```

`dist:signed` uygulamayı hardened runtime ve `build/entitlements.mac.plist` ile imzalar; electron-builder uygulamayı notarize edip bileti ekler. Ardından `.dmg`'ler de imzalanır ve `scripts/notarize-dmg.mjs` onları notarize edip bileti ekler (yalnızca dmg adımını tekrarlamak için: `npm run dist:notarize-dmg`). Doğrulama: `spctl -a -vv release/mac-arm64/DijiTerminal.app` → `source=Notarized Developer ID`.

## Geliştirme kurulumu

Gereksinimler: macOS 13+, Node 22.12+ (Electron 45 bunu şart koşuyor; nvm kullanıyorsanız `nvm use`), iTerm2.

```sh
npm install        # postinstall Electron'un macOS sürümünü indirir; Mac'te çalıştırın
                   # (indirme atlandıysa: npx install-electron)
npm run dev        # uygulamayı geliştirme modunda açar
```

## Komutlar

| Komut | Ne yapar |
|-------|----------|
| `npm run dev` | Electron'u HMR ile açar |
| `npm run build` | main, preload ve renderer'ı `out/` altına derler |
| `npm run dist` | `release/` altında arm64 + x64 .dmg ve arm64 .zip (ad-hoc imzalı); `build:mac` aynı |
| `npm run dist:universal` | Tek universal .dmg |
| `npm run dist:dir` | Yalnızca `.app` klasörü (hızlı paket denemesi) |
| `npm run dist:signed` | Developer ID ile imza + hardened runtime (`CSC_NAME`); `APPLE_KEYCHAIN_PROFILE` varsa uygulama ve .dmg notarize edilir |
| `npm run dist:notarize-dmg` | `release/` altındaki imzalı .dmg'leri notarize edip bileti ekler |
| `npm run dist:check` | Paketleme yapılandırmasını doğrular; Mac'te `-- --app release/mac-arm64/DijiTerminal.app` ile paketi de denetler |
| `npm run icon` | `build/icon.svg` → `build/icon.png` + `build/icon.icns` |
| `npm run icon:tray` | Menü çubuğu ikonlarını (`resources/tray/*Template.png`) üretir; `-- --preview <png>` önizleme |
| `npm run typecheck` | main ve renderer tsconfig'lerini ayrı ayrı denetler |
| `npm run lint` | ESLint (shared/renderer/motor import kuralları dahil) |
| `npm test` | Fixture taraması + Vitest (motor, ortak kod, renderer) |
| `npm run test:hooks` | Faz 1 hook testleri (shell + node:test) |
| `npm run test:all` | İkisi birden |
| `npm run hooks:install` / `hooks:uninstall` / `hooks:status` | Claude Code hook ve statusLine kurulumu |
| `npm run fixtures:make -- --synthetic` | Test senaryolarını yeniden üretir |
| `npm run fixtures:check` | Fixture'larda gerçek veri izi arar |
| `npm run replay -- <senaryo> --speed 5` | Bir senaryoyu geçici bir `CLAUDE_CONFIG_DIR`'e canlı oynatır |
| `npm run bench:transcripts` | Transcript okuyucunun açılış süresini ölçer |
| `npm run bench` / `bench:hidden` / `bench:big` / `bench:soak` / `bench:headless` | Performans bütçesi ölçümü — bkz. [docs/performance.md](docs/performance.md) |

## Klasör yapısı

```
src/
  shared/      ortak tipler, IPC kontratı, sabitler (electron/Node importu yasak)
  main/        Electron main process
    engine/    session motoru — saf Node, electron importu yasak
  preload/     window.diji köprüsü
  renderer/    React arayüzü
hooks/         Faz 1 hook script'leri ve kurulum aracı
scripts/       CLI araçları (kurulum, fixture, replay, benchmark)
fixtures/      sentetik ve anonim test verisi
tests/         Vitest testleri + tests/hooks (shell)
build/         ikon kaynağı (SVG) ve üretilmiş PNG/ICNS, entitlement'lar
docs/          performans notları
```

## Sürümler

Electron 45.1.0 · electron-vite 2.3 · Vite 5 · React 18 · TypeScript 5.9 · three 0.160 · Vitest 2 · ESLint 10

## Lisans

MIT — bkz. [LICENSE](LICENSE). © 2026 Ufuk Aytaş
