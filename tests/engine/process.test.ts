// ProcessInspector — 02/06. Gerçek `ps` çalıştırılmaz; çıktı fixture'lardan gelir.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyComm, normalizeTty, parsePs, ProcessInspector, PS_ARGS, resolveTerminal, type ProcRow } from '@main/engine/process';

const FX = path.join(__dirname, '__fixtures__', 'ps');
const fx = (name: string) => fs.readFileSync(path.join(FX, name), 'utf8');

describe('parsePs', () => {
  it('sütunları ayrıştırır; boşluklu comm ve bozuk satır', () => {
    const t = parsePs(fx('comm-with-spaces.txt'));
    expect(t.size).toBe(4);
    expect(t.get(400)?.comm).toBe('/Applications/Some Terminal.app/Contents/MacOS/Some Terminal');
    expect(t.get(411)).toEqual({ pid: 411, ppid: 410, tty: 'ttys020', cpu: 0.1, rssKb: 300000, comm: 'claude' });
  });

  it('ondalık virgülü kabul eder', () => {
    expect(parsePs(fx('iterm-four-tabs.txt')).get(723)?.cpu).toBe(1.5);
  });
});

describe('normalizeTty / classifyComm', () => {
  it('tty', () => {
    expect(normalizeTty('ttys004')).toBe('/dev/ttys004');
    expect(normalizeTty('/dev/ttys004')).toBe('/dev/ttys004');
    for (const v of ['??', '?', '-', '']) expect(normalizeTty(v)).toBeNull();
  });

  it('terminal uygulaması', () => {
    expect(classifyComm('/Applications/iTerm.app/Contents/MacOS/iTermServer-3.5.10')).toBe('iterm2');
    expect(classifyComm('/Applications/iTerm.app/Contents/MacOS/iTerm2')).toBe('iterm2');
    expect(classifyComm('/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal')).toBe('terminal');
    expect(classifyComm('-zsh')).toBeNull();
  });
});

describe('resolveTerminal', () => {
  it('iTerm2: dört sekme, her biri kendi tty\'siyle', () => {
    const t = parsePs(fx('iterm-four-tabs.txt'));
    expect([703, 713, 723, 733].map((p) => resolveTerminal(p, t))).toEqual([
      { app: 'iterm2', tty: '/dev/ttys004', pid: 703 },
      { app: 'iterm2', tty: '/dev/ttys005', pid: 713 },
      { app: 'iterm2', tty: '/dev/ttys006', pid: 723 },
      { app: 'iterm2', tty: '/dev/ttys007', pid: 733 },
    ]);
  });

  it('Terminal.app', () => {
    expect(resolveTerminal(803, parsePs(fx('terminal-app.txt')))).toEqual({ app: 'terminal', tty: '/dev/ttys010', pid: 803 });
  });

  it('tty yok → unknown; tanınmayan terminal → other; tabloda yok → null', () => {
    expect(resolveTerminal(900, parsePs(fx('no-tty.txt')))).toEqual({ app: 'unknown', tty: null, pid: 900 });
    expect(resolveTerminal(411, parsePs(fx('comm-with-spaces.txt')))?.app).toBe('other');
    expect(resolveTerminal(12345, parsePs(fx('no-tty.txt')))).toBeNull();
  });

  it('zincir 6 seviyede kesilir; döngüsel ppid sonsuz döngü yapmaz', () => {
    const row = (pid: number, ppid: number, comm = 'sh'): ProcRow => ({ pid, ppid, tty: 'ttys001', cpu: 0, rssKb: 0, comm });
    const deep = new Map<number, ProcRow>();
    deep.set(10, row(10, 11, 'claude'));
    for (let p = 11; p < 18; p++) deep.set(p, row(p, p + 1));
    deep.set(18, row(18, 1, 'iTerm2')); // 8. ata: ulaşılmaz
    expect(resolveTerminal(10, deep)?.app).toBe('other');

    const loop = new Map<number, ProcRow>([
      [20, row(20, 21, 'claude')],
      [21, row(21, 22)],
      [22, row(22, 21)],
    ]);
    expect(resolveTerminal(20, loop)?.app).toBe('other');
  });
});

describe('ProcessInspector', () => {
  function make(outputs: (string | Error)[], opts: { now?: () => number; alive?: (pid: number) => boolean; platform?: NodeJS.Platform } = {}) {
    const calls: string[][] = [];
    const insp = new ProcessInspector({
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        const o = outputs.shift();
        if (o instanceof Error) throw o;
        return o ?? '';
      },
      now: opts.now ?? (() => 1000),
      isAlive: opts.alive ?? (() => true),
      platform: opts.platform ?? 'darwin',
    });
    return { insp, calls };
  }

  it('tek ps çağrısı (execFile, sabit argümanlar), describe terminal + cpu + bellek', async () => {
    const { insp, calls } = make([fx('iterm-four-tabs.txt')]);
    await insp.sampleNow();
    expect(calls).toEqual([['/bin/ps', ...PS_ARGS]]);
    expect(insp.describe(703)).toEqual({ terminal: { app: 'iterm2', tty: '/dev/ttys004', pid: 703 }, cpuPct: 12.5, memMb: 410, alive: true });
  });

  it('ps hata verirse eski tablo 10 sn kullanılır, sonra terminal null', async () => {
    let now = 1000;
    const { insp } = make([fx('iterm-four-tabs.txt'), new Error('timeout')], { now: () => now });
    await insp.sampleNow();
    now = 5000;
    await insp.sampleNow();
    expect(insp.lastError).toBe('timeout');
    expect(insp.describe(703).terminal?.tty).toBe('/dev/ttys004');
    now = 11_001;
    expect(insp.describe(703).terminal).toBeNull();
  });

  it('gizli pencere (setSlow): bayatlık eşiği 3 kat; görünür olunca hemen yeniden örnekler', async () => {
    let now = 1000;
    const { insp, calls } = make([fx('iterm-four-tabs.txt'), fx('iterm-four-tabs.txt'), fx('iterm-four-tabs.txt')], { now: () => now });
    insp.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    insp.setSlow(true);
    now = 25_000; // 10 sn'yi aştı ama 30 sn'yi aşmadı: seyrek örneklemede tablo hâlâ geçerli
    expect(insp.describe(703).terminal?.tty).toBe('/dev/ttys004');
    insp.setSlow(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(2);
    insp.stop();
  });

  it('canlılık kill(pid,0) sonucundan; süreç adı canlılık kararına girmez', async () => {
    const { insp } = make([fx('iterm-four-tabs.txt')], { alive: (pid) => pid !== 733 });
    await insp.sampleNow();
    expect(insp.describe(713).alive).toBe(true); // comm sürüm numarası: yine canlı
    expect(insp.describe(733).alive).toBe(false);
  });

  it('ata zinciri önbelleği ppid değişince yenilenir; onSample bildirir', async () => {
    const moved = fx('iterm-four-tabs.txt').replace('  703   702 ttys004', '  703   722 ttys006');
    const { insp } = make([fx('iterm-four-tabs.txt'), moved]);
    let samples = 0;
    insp.onSample(() => samples++);
    await insp.sampleNow();
    expect(insp.describe(703).terminal?.tty).toBe('/dev/ttys004');
    await insp.sampleNow();
    expect(insp.describe(703).terminal?.tty).toBe('/dev/ttys006');
    expect(samples).toBe(2);
  });

  it('desteklenmeyen platformda ps çalıştırılmaz', async () => {
    const { insp, calls } = make([fx('iterm-four-tabs.txt')], { platform: 'win32' });
    insp.start();
    await insp.sampleNow();
    insp.stop();
    expect(calls).toEqual([]);
    expect(insp.describe(703).terminal).toBeNull();
  });

  it('childrenOf / descendantsOf', async () => {
    const { insp } = make([fx('iterm-four-tabs.txt')]);
    await insp.sampleNow();
    expect(insp.childrenOf(640).sort()).toEqual([701, 711, 721, 731]);
    expect(insp.descendantsOf(701)).toEqual([702, 703]);
  });
});
