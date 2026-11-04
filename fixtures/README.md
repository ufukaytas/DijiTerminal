# fixtures/

DijiTerminal'in motorunu, demo modunu ve UI'ını gerçek `~/.claude` verisi olmadan çalıştırmak için kullanılan sahte veriler. **Buradaki hiçbir şey gerçek kullanıcı verisi değildir**; `npm test` öncesinde `scripts/check-fixtures.mjs` bunu denetler.

## İçerik

| Dizin | Sahibi | Ne için |
|---|---|---|
| `<senaryo>/` (aşağıdaki 9 + big-transcript) | 05/01 | Uçtan uca senaryolar: `claude/` son durum, `timeline.json` oynatma, `manifest.json` beklentiler |
| `registry/` | 02/01 | Tek tek `sessions/<pid>.json` örnekleri |
| `transcripts/` | 02/02, 02/03 | Okuyucu/normalizer birim testleri (`secrets/` sahte anahtarlar içerir, hepsi `FAKE`) |
| `hooks/`, `claude-settings/` | 03/xx | Hook olay girdileri ve `settings.json` örnekleri |

## Senaryolar

| Ad | Kurgu | Beklenen (manifest `expect`) |
|---|---|---|
| `basic-two-sessions` | İki proje, iki boşta session | 2 session, idle |
| `waiting-permission` | `npm run db:migrate` izin bekliyor | `waiting`, `waitingFor: permission:Bash` |
| `subagents-team` | 3 subagent (haiku/inherit/background), proje ajanları `repos/` altında | 3 subagent, 2 çalışan; takım çözümlemesi |
| `fork-resume` | Eski pid çıkar, `--resume` ile yeni session geçmişi kopyalar | eski session `superseded` |
| `compact` | Aynı pid'de `/compact` sonrası yeni sessionId | `superseded`, compact_boundary |
| `conflict-same-file` | Ana dizin + worktree aynı dosyayı düzenliyor | 1 çakışma, 1 proje |
| `slow-tool` | ~10 dk süren Bash | `slow-tool` bayrağı |
| `api-error` | `isApiErrorMessage` kayıtları | 2 log hatası |
| `images-base64` | 512 KB base64 görüntü içeren tool_result | parse öncesi kırpma, süre sınırı |
| `big-transcript` | 60 MB, son ~5 MB "bugün" | ilk snapshot < 1500 ms. **Repoya girmez** (gitignore) |

Zaman: `manifest.now = 2026-01-01T09:00:00Z`; timeline `at` değerleri `now − 20 dk`'dan itibaren ms. Yollar `/Users/demo/Projects/demo-*`. `pidAliveOverride: true` → testler pid canlılığını bu bayraktan alır.

## Dizin yapısı

```
fixtures/<senaryo>/
  manifest.json   { name, description, source: synthetic|anonymized, now, pidAliveOverride, expect{…}, …ekler }
  timeline.json   [{ at, op: write|append|delete, path (claude/ altına göreli), json | line }]
  claude/         timeline sonundaki son hal (CLAUDE_CONFIG_DIR olarak verilebilir)
    sessions/<pid>.json
    projects/<encodeCwd(cwd)>/<sessionId>.jsonl
    projects/<…>/<sessionId>/subagents/agent-<id>.jsonl + .meta.json
  repos/          (isteğe bağlı) sahte proje dosyaları, manifest.repoRoots ile eşlenir
```

## Komutlar

```sh
npm run fixtures:make -- --force            # 9 sentetik senaryoyu yeniden üret
node scripts/make-fixtures.mjs --only compact --force
node scripts/make-fixtures.mjs --include-big --force   # + 60 MB big-transcript (gitignore)

npm run fixtures:check                      # sızıntı + yapı denetimi (pretest)

npm run replay -- subagents-team            # canlı gibi oynat (×5), geçici CLAUDE_CONFIG_DIR
node scripts/replay.mjs fork-resume --speed 1 --loop
node scripts/replay.mjs compact --dir /tmp/diji-cfg --once
node scripts/replay.mjs slow-tool --launch  # uygulamayı CLAUDE_CONFIG_DIR ile npm run dev olarak açar

node scripts/inspect-format.mjs             # gerçek ~/.claude'un YALNIZCA şema özeti (değer yazmaz)
```

Replay, zaman damgalarını "şimdi"ye kaydırır, registry pid'lerini canlı pid'lere eşler (ilki replay süreci, diğerleri uyuyan yardımcı süreçler) ve dosyaları Claude Code gibi yazar (registry atomik, transcript append). Geçici dizin 0700 açılır, Ctrl+C ile silinir.

## Gerçek session'dan fixture

```sh
node scripts/make-fixtures.mjs --from ~/.claude --session <sessionId> --name <ad>
```

Kaynak yalnızca okunur. Anonimleştirme (`scripts/lib/anonymize.mjs`):

- Tüm serbest metinler (prompt, yanıt, düşünce, araç girdisi/çıktısı, başlıklar) **aynı uzunlukta `▒`** olur; yapı ve sayılar korunur.
- `uuid`, `sessionId`, `message.id`, `tool_use_id`, `agentId`… tuzlu ve deterministik yeniden üretilir; ilişkiler (parentUuid, aynı message.id'li blok satırları, tool_use ↔ tool_result) bozulmaz. Tuz repo kökündeki `.fixture-salt` (gitignore).
- Yollar `/Users/demo/Projects/demo-N/…`, branch'ler `feature/demo-N`, zaman `2026-01-01T09:00Z`'a kaydırılır; base64 görüntüler 1 KB sahte veriye iner.
- `type`, `subtype`, `model`, `stop_reason`, araç adları, `status`, `kind` gibi enum alanları olduğu gibi kalır.

Çıktı önce `fixtures/.tmp-<ad>-*` altına yazılır, **katı modda** (cümle kuralı dahil) taranır; tek bulgu varsa kaydedilmez ve geçici dizin silinir. Manifest `source: "anonymized"` olur; tarayıcı bu fixture'larda okunabilir cümle kuralını her zaman uygular.

## Tarayıcı kuralları (`check-fixtures`)

`/Users/<ad>` (yalnız `demo`), dosya adında `-Users-<ad>-`, e-posta (example.*, *.invalid/test, noreply@anthropic.com hariç), bu makinenin kullanıcı adı, `sk-`/`ghp_`/`github_pat_`/`AKIA`/`xox?-` anahtarları (`FAKE` içerenler hariç), anonimleştirilmiş fixture'larda metin alanında okunabilir cümle. Bulgular yalnızca `dosya:satır kural` olarak yazılır, değer basılmaz. `big-transcript/`, `transcripts/big/` ve `.tmp-*` atlanır; `fixtures/` 3 MB'ı aşarsa uyarı verir.
