// Toast'lar sayfanın altında (03/01).
import { useToasts } from '../state/toast';

export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast t-${t.level}`}>
          <span>{t.message}</span>
          {t.action ? (
            <button
              type="button"
              className="toast-act"
              onClick={() => {
                const id = t.action?.id;
                dismiss(t.id);
                if (id) void window.diji?.invoke('app:toastAction', id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" className="toast-x" aria-label="Kapat" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
