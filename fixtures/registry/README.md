# fixtures/registry

02/01 RegistryWatcher testleri için `~/.claude/sessions/<pid>.json` örnekleri (sentetik). Testler bunları geçici bir
`sessions/` klasörüne `<pid>.json` adıyla kopyalar; pid canlılığı `isAlive` stub'ıyla belirlenir.

| Dosya | pid | Senaryo | Listede mi |
|-------|-----|---------|-----------|
| `interactive-busy.json` | 41001 | Normal, çalışıyor | Evet, busy |
| `interactive-waiting.json` | 41002 | Onay bekliyor (`waitingFor`) | Evet, waiting |
| `interactive-shell.json` | 41003 | `status: shell`, zamanlar saniye cinsinden | Evet, idle (rawStatus shell) |
| `spare.json` | 41004 | Önceden başlatılmış yedek süreç | Hayır |
| `background-kind.json` | 41005 | `kind: background` | Hayır |
| `hosted.json` | 41006 | Başka session içinde barınan | Hayır |
| `superseded-a.json` / `superseded-b.json` | 41007 | Aynı süreçte sessionId değişimi (compact/resume) | b; a → b superseded |
