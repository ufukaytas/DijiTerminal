# fixtures/claude-settings

01/02 HookInstaller testleri için `~/.claude/settings.json` başlangıç durumları.

| Dosya | Senaryo |
|-------|---------|
| (dosya yok) | `empty` — settings.json hiç yok |
| `minimal.json` | `{}` |
| `with-user-hooks.json` | Kullanıcının kendi Stop, matcher'lı PreToolUse ve PreCompact hook'ları |
| `with-statusline.json` | Kullanıcının tırnaklı komutlu, padding'li statusLine'ı |
| `with-both.json` | Hem kullanıcı hook'u hem statusLine |
| `invalid.json` | Bozuk JSON (sondaki virgül, kapanmayan parantez) |
