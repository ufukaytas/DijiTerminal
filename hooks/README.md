# hooks/ — Faz 1: iTerm2 trafik ışığı ve bildirimler

Bu klasör DijiTerminal uygulaması olmadan da çalışır. Claude Code hook'ları her durum değişikliğinde buradaki script'i çağırır; iTerm2 sekmesi duruma göre renk alır, onay bekleyen ya da uzun süren bir tur bittiğinde masaüstü bildirimi gelir.

## Kurulum

```sh
npm run hooks:install      # planı gösterir, onay ister, settings.json'u yedekleyip kurar
npm run hooks:status       # durum
npm run hooks:uninstall    # yalnızca DijiTerminal kayıtlarını kaldırır
```

Kurulumdan sonra **açık Claude Code session'larını yeniden başlatın**; hook'lar session açılışında okunur.

Kurulum ne yapar:
- `~/.claude/settings.json`'u (ya da `$CLAUDE_CONFIG_DIR/settings.json`) `~/Library/Application Support/DijiTerminal/backups/` altına yedekler.
- Script'leri `~/Library/Application Support/DijiTerminal/hooks/` altına kopyalar; kayıtlar bu kopyayı gösterir, repo taşınsa da çalışır.
- 8 hook olayına (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`, `SessionEnd`) kendi kaydını ayrı bir grup olarak ekler. Sizin hook'larınıza dokunmaz.
- `statusLine` yoksa kendi script'ini ekler. Varsa sizinkini silmez, **zincirler**: status line'ınız aynen görünür, DijiTerminal yalnızca kullanım limitlerini `limits.json`'a kaydeder. İstemezseniz: `node scripts/install-hooks.mjs install --no-statusline`.

## Sekme renkleri

| Olay | Sekme |
|------|-------|
| Prompt gönderildi, araç çalışıyor | mavi |
| İzin / onay bekliyor | amber |
| Tur bitti, girdi bekliyor | yeşil |
| Session kapandı | varsayılan renk |

Renkler yalnızca iTerm2'de uygulanır; diğer terminallerde hiçbir kaçış karakteri basılmaz. Olaylar her durumda `~/Library/Application Support/DijiTerminal/hook-events.jsonl` dosyasına yazılır (uygulama Faz 2'de buradan okur). Prompt metni loglanmaz.

Elle deneme (iTerm2 içinde):

```sh
echo '{"session_id":"deneme","hook_event_name":"Notification","message":"Claude needs your permission to use Bash","cwd":"/tmp"}' | sh hooks/dijiterminal-hook.sh
```

Bu komut hook'u terminalin kendi sürecinden çalıştırır; sekme amber olur. Varsayılana döndürmek için aynı komutu `"hook_event_name":"SessionEnd"` ile çalıştırın.

## Bildirimler

- **Onay bekliyor:** bir session izin istediğinde. Aynı session için 60 sn içinde tekrar bildirim gelmez.
- **Bitti:** en az 30 sn süren bir tur bittiğinde.
- DijiTerminal uygulaması açıksa bu script bildirim göstermez; bildirimleri uygulama verir.

Ayarlar `~/Library/Application Support/DijiTerminal/notify.conf` dosyasında (`WAITING`, `DONE`, `DONE_MIN_SEC`, `SOUND`); örnek: `notify.conf.example`.

**Bildirime tıklayınca doğru sekmeye gitmek için** `terminal-notifier` önerilir:

```sh
brew install terminal-notifier
```

Kurulu değilse bildirimler `osascript` ile gelir. Bu durumda macOS bildirimi "Script Editor" adıyla gösterir ve ilk seferde izin ister; bildirime tıklamak sekmeye götürmez.

İlk tıklamada macOS, iTerm2'yi kontrol etmek için **Otomasyon izni** ister (Sistem Ayarları › Gizlilik ve Güvenlik › Otomasyon). Reddedilirse bildirimler gelir ama tıklama sekmeyi seçmez.

## Dosyalar

| Dosya | Görev |
|-------|-------|
| `dijiterminal-hook.sh` | Hook girişi: sekme rengi, olay logu, bildirim çağrısı |
| `statusline.sh` | statusLine: `limits.json` kaydı + varsa önceki komutunuzu zincirleme |
| `notify.sh` | Masaüstü bildirimleri |
| `focus-tty.sh` | Bildirime tıklanınca tty'ye göre iTerm2 sekmesini seçer |
| `lib/installer.mjs` | Kurulum mantığı (CLI ve Faz 2 uygulaması ortak kullanır) |

## Testler

```sh
npm run test:hooks
```
