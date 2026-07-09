export interface ToastItem {
  id: string;
  tone: "ok" | "fail";
  title: string;
  detail?: string;
}

const TONE: Record<ToastItem["tone"], { border: string; badge: string; label: string }> = {
  ok: { border: "border-ok/40", badge: "border-ok/50 bg-ok/20 text-ok", label: "Done" },
  fail: { border: "border-fail/45", badge: "border-fail/50 bg-fail/20 text-fail", label: "Failed" },
};

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const tone = TONE[toast.tone];
  return (
    <div
      role="status"
      className={`pointer-events-auto flex items-start gap-3 rounded-panel border ${tone.border} bg-surface px-4 py-3 shadow-[0_8px_30px_rgb(0_0_0/0.25)]`}
    >
      <span
        className={`mt-0.5 shrink-0 rounded-md border px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] ${tone.badge}`}
      >
        {tone.label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">{toast.title}</p>
        {toast.detail && (
          <p className="mt-0.5 truncate font-mono text-xs text-ink-faint">{toast.detail}</p>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        className="-mr-1 shrink-0 rounded-md px-1.5 text-ink-faint transition hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}

/** Bottom-right stack of transient notifications. A polite live region so a
 *  screen reader announces each toast without stealing focus. */
export function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
