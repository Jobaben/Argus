import { useFlip } from "./flip";
import { useListPresence } from "./presence";

export interface ToastItem {
  id: string;
  /** `info` is for things worth seeing but not worth alarm — a warn-level
   *  anomaly, say. Painting those the same red as a failed run is how a colour
   *  stops carrying information. */
  tone: "ok" | "fail" | "info";
  title: string;
  detail?: string;
}

const TONE: Record<ToastItem["tone"], { border: string; badge: string; label: string }> = {
  ok: { border: "border-ok/40", badge: "border-ok/50 bg-ok/20 text-ok", label: "Done" },
  fail: { border: "border-fail/45", badge: "border-fail/50 bg-fail/20 text-fail", label: "Failed" },
  info: {
    border: "border-queue/40",
    badge: "border-queue/50 bg-queue/20 text-queue",
    label: "Notice",
  },
};

function Toast({
  toast,
  onDismiss,
  leaving,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
  /** True once the queue has dropped it and it is animating away. */
  leaving: boolean;
}) {
  const tone = TONE[toast.tone];
  return (
    <div
      role="status"
      // A notification surface with no animation at all was the loudest
      // unfinished signal in the app: its entire job is to catch the eye
      // gracefully, and it popped into existence. In on a slight overshoot —
      // that settle is what does the catching, without the colour or the motion
      // having to shout. Out sideways, off the stack's own axis, so a dismissal
      // never reads as the toast below it moving up.
      className={`pointer-events-auto flex items-start gap-3 rounded-panel border ${tone.border} bg-surface px-4 py-3 shadow-[0_8px_30px_rgb(0_0_0/0.25)] ${
        leaving
          ? "motion-safe:animate-[toast-out_var(--duration-exit)_var(--ease-in-expo)_forwards]"
          : "motion-safe:animate-[toast-in_var(--duration-base)_var(--ease-spring)_both]"
      }`}
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
        className="-mr-1 shrink-0 rounded-md px-1.5 text-ink-faint transition hover:text-ink motion-safe:active:scale-90"
      >
        ×
      </button>
    </div>
  );
}

/**
 * Bottom-right stack of transient notifications. A polite live region so a
 * screen reader announces each toast without stealing focus.
 *
 * The stack owns two animations it cannot get from the toast alone. `useListPresence`
 * holds a dismissed toast in the tree long enough to leave — the queues that own
 * these simply delete the item, so by the time this re-renders there would be
 * nothing left to animate. `useFlip` then glides the remaining toasts into the
 * gap instead of snapping them upward, which is what the stack did before: one
 * dismissal and everything below it teleported.
 */
export function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  const shown = useListPresence(toasts, (t) => t.id);
  const flip = useFlip();
  if (shown.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {shown.map(({ key, item, leaving }) => (
        <div key={key} ref={flip(key)}>
          <Toast toast={item} onDismiss={onDismiss} leaving={leaving} />
        </div>
      ))}
    </div>
  );
}
