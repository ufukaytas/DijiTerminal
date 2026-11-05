// procStart karşılaştırması — Linux saat tıkı ve macOS `ps lstart` biçimleri.
import { describe, expect, it } from 'vitest';
import { normStart, sameProcessStart } from '@main/engine/proc-start';

describe('sameProcessStart', () => {
  it('Linux: saat tıkları birebir', () => {
    expect(sameProcessStart('347', '347')).toBe(true);
    expect(sameProcessStart('347', '901')).toBe(false);
  });

  it('macOS: ps lstart metni, tek haneli gün hizalaması fark etmez', () => {
    expect(sameProcessStart('Thu Oct  8 08:12:33 2026', 'Thu Oct 8 08:12:33 2026')).toBe(true);
    expect(sameProcessStart('Wed Oct 28 08:12:33 2026\n', 'Wed Oct 28 08:12:33 2026')).toBe(true);
  });

  it('macOS: farklı başlangıç → başka süreç', () => {
    expect(sameProcessStart('Wed Oct 28 09:40:01 2026', 'Wed Oct 28 08:12:33 2026')).toBe(false);
  });

  it('macOS: kayıt UTC, ps yerel saat (Claude Code 2.1.3xx) → aynı süreç; başka saat → farklı', () => {
    const local = new Date(Date.UTC(2026, 10, 5, 6, 29, 12)); // 06:29:12Z, yerel saatle biçimlenir
    const pad = (n: number) => String(n).padStart(2, '0');
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fmt = (d: Date, utc: boolean) => {
      const g = (l: () => number, u: () => number) => (utc ? u() : l());
      return `${DAYS[g(() => d.getDay(), () => d.getUTCDay())]} ${MONTHS[g(() => d.getMonth(), () => d.getUTCMonth())]} ${g(() => d.getDate(), () => d.getUTCDate())} ${pad(g(() => d.getHours(), () => d.getUTCHours()))}:${pad(g(() => d.getMinutes(), () => d.getUTCMinutes()))}:${pad(g(() => d.getSeconds(), () => d.getUTCSeconds()))} ${g(() => d.getFullYear(), () => d.getUTCFullYear())}`;
    };
    expect(sameProcessStart(fmt(local, false), fmt(local, true))).toBe(true);
    const other = new Date(local.getTime() + 47 * 60_000);
    expect(sameProcessStart(fmt(other, false), fmt(local, true))).toBe(false);
  });

  it('karşılaştırılamayan biçim (yerel ayar) → null, ps/startedAt yoluna düşülür', () => {
    expect(sameProcessStart('Wed Oct 28 08:12:33 2026', 'Çar Eki 28 08:12:33 2026')).toBeNull();
  });

  it('normStart boşlukları sadeleştirir', () => {
    expect(normStart('  Thu Oct  8 08:12:33 2026 \n')).toBe('Thu Oct 8 08:12:33 2026');
  });
});
