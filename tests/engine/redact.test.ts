import { describe, expect, it } from 'vitest';
import { redact, REDACTED, REDACT_MAX_INPUT } from '@main/engine/redact';

describe('redact — gizlenmesi gerekenler', () => {
  it.each([
    ['Anthropic', 'key sk-ant-api03-FAKEFAKEFAKE_fake-00 son', `key ${REDACTED} son`],
    ['OpenAI tarzı', 'sk-FAKEFAKEFAKEFAKEFAKE1234 bitti', `${REDACTED} bitti`],
    ['GitHub ghp', 'ghp_FAKEFAKEFAKEFAKEFAKE00 x', `${REDACTED} x`],
    ['GitHub gho', 'gho_FAKEFAKEFAKEFAKEFAKE00', REDACTED],
    ['GitHub PAT', 'github_pat_FAKEFAKEFAKEFAKEFAKE_00', REDACTED],
    ['Slack', 'xoxb-FAKE-0000-FAKEFAKE', REDACTED],
    ['AWS', 'id=AKIAFAKEFAKEFAKE1234', `id=${REDACTED}`],
    ['JWT', 'eyJFAKEFAKEFAKE.eyJFAKEFAKEFAKEFAKE.FAKEFAKEFAKEFAKE', REDACTED],
    ['Bearer', 'Authorization: Bearer FAKEFAKEFAKEFAKE1234', `Authorization: Bearer ${REDACTED}`],
    ['Basic', 'Basic FAKEFAKEFAKEFAKE1234==', `Basic ${REDACTED}`],
    ['API_KEY=', 'API_KEY=FAKEvalue npm run', `API_KEY=${REDACTED} npm run`],
    ['token:', 'token: FAKE-token-1', `token: ${REDACTED}`],
    ['password çift tırnak', 'password = "FAKE pass"', `password = ${REDACTED}`],
    ['secret tek tırnak', "SECRET='FAKE'", `SECRET=${REDACTED}`],
    ['passwd', 'passwd:FAKE', `passwd:${REDACTED}`],
    ['api-key', 'api-key=FAKE', `api-key=${REDACTED}`],
  ])('%s', (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('bir metinde birden çok sır', () => {
    const out = redact('export A=sk-ant-api03-FAKEFAKEFAKE && gh auth --with-token ghp_FAKEFAKEFAKEFAKEFAKE00');
    expect(out).not.toMatch(/FAKE/);
    expect(out.match(new RegExp(REDACTED, 'g'))?.length).toBe(2);
  });
});

describe('redact — yanlış pozitif olmamalı', () => {
  it.each([
    ['kısa sk-', 'sk-learn kütüphanesi'],
    ['task-runner', 'npm run task-runner'],
    ['ghp kısa', 'ghp_abc'],
    ['AKIA kısa', 'AKIA123'],
    ['eyJ tek parça', 'eyJhbGciOiJIUzI1NiJ9'],
    ['Bearer kısa', 'Bearer token'],
    ['tokenizer kelimesi', 'tokenizer çalışıyor'],
    ['secretary', 'secretary=ayşe'],
    ['normal komut', 'npm test -- editor'],
    ['Türkçe metin', 'Şifre alanını düzelt, parola doğrulamasını ekle'],
  ])('%s', (_name, input) => {
    expect(redact(input)).toBe(input);
  });
});

describe('redact — sınırlar', () => {
  it('boş metin', () => {
    expect(redact('')).toBe('');
  });
  it(`${REDACT_MAX_INPUT} karakterden uzun girdi önce kırpılır`, () => {
    const out = redact('x'.repeat(10_000) + ' sk-ant-api03-FAKEFAKEFAKE');
    expect(out.length).toBe(REDACT_MAX_INPUT);
    expect(out).not.toContain('sk-ant');
  });
  it('patolojik girdi hızlı biter (regex DoS yok)', () => {
    const evil = 'token=' + 'a'.repeat(50_000) + ' ' + 'eyJ'.repeat(5000);
    const t = performance.now();
    redact(evil);
    expect(performance.now() - t).toBeLessThan(50);
  });
});
