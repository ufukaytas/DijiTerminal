// Süreç canlılığı ve başlangıç zamanı — 02/01. Sinyal göndermez; ps her zaman execFile ile çağrılır.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

/** pid canlı mı? kill(pid, 0) sinyal göndermez; EPERM = süreç var ama bizim değil. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const lstartCache = new Map<number, string | null>();

/** `ps -o lstart= -p <pid>` ham çıktısı (LC_ALL=C, boşluklar sadeleşmiş). Sonuç pid başına cache'lenir. */
function lstart(pid: number): Promise<string | null> {
  if (lstartCache.has(pid)) return Promise.resolve(lstartCache.get(pid) ?? null);
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2000, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      const raw = err ? '' : normStart(String(stdout));
      const v = raw || null;
      lstartCache.set(pid, v);
      resolve(v);
    });
  });
}

/** `ps lstart` → başlangıç zamanı (ms). Hata/boş → null. */
export async function processStartMs(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const raw = await lstart(pid);
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** pid öldüğünde ya da başka bir süreçle eşleştiğinde cache'ten çıkar. */
export function forget(pid: number): void {
  lstartCache.delete(pid);
}

/**
 * Claude Code'un registry'ye yazdığı `procStart` ile karşılaştırılabilir süreç başlangıç belirteci.
 * Linux: /proc/<pid>/stat 22. alan (açılıştan beri saat tıkı) — gerçek registry örneğiyle doğrulandı.
 * macOS: `ps -o lstart` metni (ör. "Wed Oct 28 08:12:33 2026") — Mac'teki registry'nin biçimiyle doğrulandı.
 */
export async function procStartToken(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'darwin') return lstart(pid);
  if (platform !== 'linux') return null;
  try {
    const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // rest[0] = 3. alan (state) → 22. alan = rest[19]
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

/** Boşlukları sadeleştir: ps tek haneli günü iki boşlukla hizalar ("Oct  8"). */
export function normStart(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * Canlı süreç belirteci registry'deki `procStart` ile aynı süreci mi gösteriyor?
 * true/false: kesin. null: biçimler karşılaştırılamıyor (ör. farklı yerel ayarla yazılmış tarih) → çağıran ps/startedAt yoluna düşer.
 */
export function sameProcessStart(token: string, recorded: string): boolean | null {
  const a = normStart(token);
  const b = normStart(recorded);
  if (a === b) return true;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return false; // Linux saat tıkı
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return Math.abs(ta - tb) <= 1000;
  return null;
}
