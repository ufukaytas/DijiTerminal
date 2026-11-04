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

  it('karşılaştırılamayan biçim (yerel ayar) → null, ps/startedAt yoluna düşülür', () => {
    expect(sameProcessStart('Wed Oct 28 08:12:33 2026', 'Çar Eki 28 08:12:33 2026')).toBeNull();
  });

  it('normStart boşlukları sadeleştirir', () => {
    expect(normStart('  Thu Oct  8 08:12:33 2026 \n')).toBe('Thu Oct 8 08:12:33 2026');
  });
});
