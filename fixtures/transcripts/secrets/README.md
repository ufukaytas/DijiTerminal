# fixtures/transcripts/secrets

Redaksiyon testi (02/03). Prompt, Bash komutları, asistan metni ve `last-prompt` içinde **sahte** anahtarlar var: Anthropic (`sk-ant-`), GitHub (`ghp_`, `github_pat_`), AWS (`AKIA…`), Slack (`xoxb-`), JWT, `Bearer`, `token:`, `password=`, `api_key =`.

Her sahte değer `FAKE` içerir; bunlar gerçek anahtar değildir ve fixture tarayıcısının (`scripts/check-fixtures.mjs`) gerçek sızıntı saymaması için bu işaretle yazılmıştır. Test, normalizer çıktısında hiçbirinin görünmediğini doğrular.
