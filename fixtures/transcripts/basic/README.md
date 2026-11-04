# fixtures/transcripts/basic

Sentetik, tek ana session'lık transcript (02/03 EventNormalizer). Kayıt yapısı Claude Code'un jsonl düzenini izler; içerik uydurmadır.

İçerik: kullanıcı prompt'u, thinking, Read, Grep, Edit (metin + araç aynı mesajda), çok satırlı Bash, WebSearch (toolUseResult.results ile 6 bağlantı), WebFetch (code/bytes), Agent (toolUseResult.agentId/status/resolvedModel), end_turn, `system/turn_duration`, `ai-title`, `last-prompt`. Aynı `message.id` (`msg_b01`) iki satırda tekrar eder: usage bir kez sayılmalı.
