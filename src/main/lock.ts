// Tek örnek kilidi ve app.lock dosyası (00/03).
// `electron` yalnızca tip olarak kullanılır; app nesnesi parametreyle gelir (test edilebilir).
import fs from 'node:fs';
import path from 'node:path';
import type { App } from 'electron';

export const APP_LOCK_FILE = 'app.lock';

/**
 * İkinci örnek kilidi alamaz ve kapanır; ilk örnekte `onSecond` çağrılır (pencereyi öne getirir).
 * @returns bu süreç kilidi aldıysa true
 */
export function acquireSingleInstance(
  app: Pick<App, 'requestSingleInstanceLock' | 'quit' | 'on'>,
  onSecond: () => void,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    // Sessiz çıkış kafa karıştırıyor (ör. kurulu .app açıkken `npm run dev`): nedenini terminale yaz.
    console.warn(
      '[DijiTerminal] Başka bir DijiTerminal örneği zaten çalışıyor (kurulu uygulama ya da önceki `npm run dev`); ' +
        'o öne getirildi, bu örnek kapanıyor. Yeni sürümü denemek için önce açık olanı ⌘Q ile kapatın.',
    );
    app.quit();
    return false;
  }
  app.on('second-instance', () => onSecond());
  return true;
}

/**
 * Faz 1 hook'ları (01/03, hooks/notify.sh) "uygulama açık mı" sorusunu bu dosyadaki pid'e bakarak cevaplar:
 * pid canlı **ve** süreç adı DijiTerminal/Electron ise kendi bildirimini atlar. Böylece çökmeden kalan
 * dosya ya da pid'in başka bir sürece geçmesi bildirimleri susturmaz. Biçim: `{"pid":…,"startedAt":…}` (04/02).
 * Çökmeden kalan eski dosyanın üzerine yazılır.
 */
export function writeAppLock(dir: string, pid: number = process.pid, now: number = Date.now()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, APP_LOCK_FILE);
    fs.writeFileSync(file, JSON.stringify({ pid, startedAt: now }), { mode: 0o600 });
    fs.chmodSync(file, 0o600); // mode yalnızca yeni dosyada uygulanır; eski dosya kalmış olabilir
  } catch (e) {
    console.warn('[lock] app.lock yazılamadı:', e);
  }
}

/** Yalnızca bu sürecin yazdığı kilidi siler (başka bir örneğin kilidine dokunmaz). */
export function removeAppLock(dir: string, pid: number = process.pid): void {
  const file = path.join(dir, APP_LOCK_FILE);
  try {
    if (lockPid(fs.readFileSync(file, 'utf8')) === pid) fs.unlinkSync(file);
  } catch {
    // dosya yok — sorun değil
  }
}

/** Kilit içeriğindeki pid: JSON ya da (eski biçim) düz sayı. */
export function lockPid(text: string): number | null {
  const m = /(\d+)/.exec(text);
  return m && m[1] ? Number(m[1]) : null;
}
