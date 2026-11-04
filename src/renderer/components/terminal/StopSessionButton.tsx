// "Session'ı kapat" (07/01): çalışan arka plan session'ını durdurur (`claude stop`) ve haritadan kaldırır; bitmiş/uyuyan
// session'ı yalnızca kaldırır. Konuşma silinmez (`claude attach <id>` ile dönülebilir). Çalışan iş kesildiği için
// iki adımlı onay (ilk tıklama "Emin misiniz?", 4 sn içinde ikinci tıklama kapatır). Tarayıcı diyaloğu kullanılmaz.
import { useEffect, useRef, useState } from 'react';
import { stopBackground } from '../../state/actions';

const ARM_MS = 4000;

export function StopSessionButton({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onClick = async () => {
    if (busy) return;
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), ARM_MS);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
    setBusy(true);
    await stopBackground(sessionId);
    setBusy(false);
  };
  return (
    <button
      type="button"
      className={`btn danger${compact ? ' sm' : ''}${armed ? ' armed' : ''}`}
      onClick={() => void onClick()}
      disabled={busy}
      aria-busy={busy || undefined}
      title="Çalışıyorsa durdurur (claude stop) ve haritadan kaldırır. Konuşma silinmez; claude attach <id> ile dönülebilir."
    >
      {busy ? 'Kapatılıyor…' : armed ? 'Emin misiniz? Kapat' : "Session'ı kapat"}
    </button>
  );
}
