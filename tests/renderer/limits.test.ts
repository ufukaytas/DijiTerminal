// Üst bar limit gösterimi (02/08).
import { describe, expect, it } from 'vitest';
import { fmtAgo, fmtResets, limitsView } from '@renderer/lib/limits';

const NOW = new Date(2026, 0, 1, 12, 0, 0).getTime(); // yerel saat, Perşembe

describe('limitsView', () => {
  it('veri yoksa null', () => {
    expect(limitsView(null, NOW)).toBeNull();
    expect(limitsView({ fiveHour: null, week: null, at: NOW }, NOW)).toBeNull();
  });

  it('seviyeler: <85 ok, ≥85 warn, ≥95 crit', () => {
    const v = (pct: number) => limitsView({ fiveHour: { pct, resetsAt: NOW + 3_600_000 }, week: null, at: NOW }, NOW)?.items[0]?.level;
    expect(v(42)).toBe('ok');
    expect(v(85)).toBe('warn');
    expect(v(95.2)).toBe('crit');
  });

  it('sıfırlanma: 24 saat içinde saat, sonrası gün + saat; geçmişse "sıfırlandı"', () => {
    const v = limitsView(
      {
        fiveHour: { pct: 90, resetsAt: NOW - 1000 },
        week: { pct: 61.4, resetsAt: new Date(2026, 0, 3, 9, 0).getTime() },
        at: NOW,
      },
      NOW,
    );
    expect(v?.items[0]).toMatchObject({ label: '5s', reset: true, pct: 0, level: 'ok', resetsLabel: null });
    expect(v?.items[1]).toMatchObject({ label: 'hafta', pct: 61, resetsLabel: 'Cmt 09:00' });
    expect(fmtResets(new Date(2026, 0, 1, 14, 30).getTime(), NOW)).toBe('14:30');
  });

  it('6 saatten eski veri bayat', () => {
    const l = { fiveHour: { pct: 10, resetsAt: 0 }, week: null, at: NOW - 7 * 3_600_000 };
    expect(limitsView(l, NOW)?.stale).toBe(true);
    expect(limitsView(l, NOW)?.updatedLabel).toBe('Son güncelleme 7 sa önce');
    expect(limitsView({ ...l, at: NOW - 60_000 }, NOW)?.stale).toBe(false);
  });

  it('fmtAgo', () => {
    expect(fmtAgo(10_000)).toBe('az önce');
    expect(fmtAgo(5 * 60_000)).toBe('5 dk önce');
    expect(fmtAgo(72 * 3_600_000)).toBe('3 gün önce');
  });
});
