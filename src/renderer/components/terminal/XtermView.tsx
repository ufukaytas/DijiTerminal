// Tek terminal sekmesi (07/01): xterm.js örneği. Akış state/terminals.ts'teki yönlendiriciden doğrudan yazılır;
// kullanıcı girdisi `term:write` ile main'e gider. Uygulama kendiliğinden hiçbir şey yazmaz.
import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { registerSink, rememberDims, requestRedraw, sendInput, sendResize } from '../../state/terminals';

/** tokens.css ile uyumlu koyu tema. */
export const XTERM_THEME: ITheme = {
  background: '#0b0e13',
  foreground: '#e4e8ef',
  cursor: '#e4e8ef',
  cursorAccent: '#0b0e13',
  selectionBackground: '#2a3d5a',
  black: '#1f2632',
  red: '#ff7a6b',
  green: '#4cc38a',
  yellow: '#f2b134',
  blue: '#5eb3ff',
  magenta: '#c98bff',
  cyan: '#7dd3c0',
  white: '#aeb8cc',
  brightBlack: '#5a6478',
  brightRed: '#ff9f8f',
  brightGreen: '#7ee0ad',
  brightYellow: '#ffd27a',
  brightBlue: '#8fcbff',
  brightMagenta: '#ddb3ff',
  brightCyan: '#a7e8da',
  brightWhite: '#ffffff',
};

/** Ctrl+Z (tek başına): pty'de job control yok, attach istemcisi askıda kalırdı → gönderilmez. */
export function isSuspendKey(
  e: Pick<KeyboardEvent, 'type' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>,
): boolean {
  return e.type === 'keydown' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z';
}

export interface XtermViewProps {
  termId: string;
  active: boolean;
  fontSize: number;
  webgl: boolean;
  onSuspendKey(): void;
}

export function XtermView({ termId, active, fontSize, webgl, onSuspendKey }: XtermViewProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const suspendRef = useRef(onSuspendKey);
  useEffect(() => {
    suspendRef.current = onSuspendKey;
  }, [onSuspendKey]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const t = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
      fontSize,
      lineHeight: 1.15,
      theme: XTERM_THEME,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      convertEol: false,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    term.current = t;
    fit.current = f;
    t.attachCustomKeyEventHandler((e) => {
      if (isSuspendKey(e)) {
        suspendRef.current();
        return false;
      }
      return true;
    });
    const subs = [t.onData((d) => void sendInput(termId, d)), t.onBinary((d) => void sendInput(termId, d))];
    const unsink = registerSink(termId, { write: (d) => t.write(d), reset: () => t.reset() });

    const doFit = () => {
      if (disposed || !el.isConnected || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        f.fit();
      } catch {
        return;
      }
      rememberDims(termId, t.cols, t.rows);
      void sendResize(termId, t.cols, t.rows);
    };

    const onFocus = () => void requestRedraw(termId);
    // Yazı tipi yüklenmeden ölçülürse hücre genişliği yanlış çıkar.
    const fontReady =
      typeof document !== 'undefined' && document.fonts
        ? document.fonts.load(`${fontSize}px "IBM Plex Mono"`).catch(() => undefined)
        : Promise.resolve();
    void fontReady.then(() => {
      if (disposed) return;
      t.open(el);
      doFit();
      // Sekmeye dönülünce (odak) session bu sekmenin boyutuyla yeniden çizilsin: aynı session'a iTerm2'den de
      // bağlanılmışsa ekran onun boyutunda çizilmiş olabilir.
      t.textarea?.addEventListener('focus', onFocus);
      if (webgl) {
        void import('@xterm/addon-webgl')
          .then(({ WebglAddon }) => {
            if (disposed) return;
            const w = new WebglAddon();
            w.onContextLoss(() => w.dispose());
            t.loadAddon(w);
          })
          .catch(() => undefined);
      }
    });

    let raf = 0;
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(doFit);
          })
        : null;
    ro?.observe(el);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      unsink();
      t.textarea?.removeEventListener('focus', onFocus);
      for (const s of subs) s.dispose();
      t.dispose();
      term.current = null;
      fit.current = null;
    };
    // fontSize ve webgl değişince yeniden kurulmaz; aşağıdaki efekt günceller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  useEffect(() => {
    const t = term.current;
    if (!t || t.options.fontSize === fontSize) return;
    t.options.fontSize = fontSize;
    try {
      fit.current?.fit();
      void sendResize(termId, t.cols, t.rows);
    } catch {
      // henüz açılmadı
    }
  }, [fontSize, termId]);

  useEffect(() => {
    if (!active) return;
    const t = term.current;
    requestAnimationFrame(() => {
      try {
        fit.current?.fit();
        if (t) void sendResize(termId, t.cols, t.rows);
      } catch {
        // yok
      }
      t?.focus();
    });
  }, [active, termId]);

  return <div ref={host} className={active ? 'xterm-host on' : 'xterm-host'} data-term={termId} />;
}
