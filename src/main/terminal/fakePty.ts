// Sahte pty (07/01): `npm run bench -- --terminal` ve geliştirme için. Gerçek CLI çağırmaz; Claude Code'a benzer,
// tamamen uydurma ANSI çıktı akıtır (anonim; gerçek prompt/kod yok). Yalnızca DIJI_TERMINAL_FAKE=1 iken.
import type { PtyProcess, PtySpawn } from './ptyManager';

const WORDS = [
  'dosya',
  'okundu',
  'test',
  'derleme',
  'özet',
  'adım',
  'kontrol',
  'tamam',
  'sonuç',
  'değişiklik',
  'araç',
  'liste',
];
const word = (i: number): string => WORDS[i % WORDS.length] ?? 'x';

/** Saniyede ~20 satır (≈1,5 KB/sn) üretir; 40 satırda bir ekranı temizleyip başlığı yeniden çizer. */
export const fakePtySpawn: PtySpawn = async (_file, _args, opts) => {
  let cols = opts.cols;
  let rows = opts.rows;
  let n = 0;
  let alive = true;
  const dataCbs = new Set<(d: string) => void>();
  const exitCbs = new Set<(e: { exitCode: number }) => void>();
  const emit = (d: string) => {
    for (const cb of dataCbs) cb(d);
  };
  const header = () =>
    `\x1b[2J\x1b[H\x1b[38;5;209m▐▛███▜▌\x1b[0m \x1b[1mClaude Code\x1b[0m \x1b[2m(sahte akış · ${cols}×${rows})\x1b[0m\r\n\r\n`;
  const start = setTimeout(() => emit(header()), 30);
  const timer = setInterval(() => {
    if (!alive) return;
    n++;
    if (n % 40 === 0) emit(header());
    const line = `\x1b[38;5;75m●\x1b[0m ${word(n)} ${word(n * 7)} ${word(n * 13)} \x1b[2m${n}\x1b[0m`;
    emit(`${line}\r\n`);
  }, 50);
  timer.unref?.();
  const proc: PtyProcess = {
    pid: 0,
    onData: (cb) => {
      dataCbs.add(cb);
      return { dispose: () => dataCbs.delete(cb) };
    },
    onExit: (cb) => {
      exitCbs.add(cb);
      return { dispose: () => exitCbs.delete(cb) };
    },
    write: (d) => {
      if (alive) emit(d.replace(/\r/g, '\r\n'));
    },
    resize: (c, r) => {
      cols = c;
      rows = r;
    },
    kill: () => {
      if (!alive) return;
      alive = false;
      clearTimeout(start);
      clearInterval(timer);
      setTimeout(() => {
        for (const cb of exitCbs) cb({ exitCode: 0 });
      }, 0);
    },
  };
  return proc;
};
