import { useFlip } from "./flip";
import { Icon, type IconName } from "./Icon";
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

const TONE: Record<
  ToastItem["tone"],
  { rule: string; text: string; label: string; icon: IconName }
> = {
  ok: { rule: "bg-ok", text: "text-ok", label: "Done", icon: "check-circle" },
  fail: { rule: "bg-fail", text: "text-fail", label: "Failed", icon: "x-circle" },
  info: { rule: "bg-queue", text: "text-queue", label: "Notice", icon: "info" },
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
      // A surface on its way out is a picture of a toast: `inert` takes it out of
      // the pointer's reach, the tab order and the accessibility tree at once, so
      // a dismissal cannot be clicked twice and a screen reader does not walk
      // into a notification that is already gone. `aria-hidden` alongside it
      // because jsdom implements `inert` as an attribute and nothing more — the
      // same pairing `Drawer` and `Handoff` use.
      inert={leaving}
      aria-hidden={leaving ? true : undefined}
      // A notification surface with no animation at all was the loudest
      // unfinished signal in the app: its entire job is to catch the eye
      // gracefully, and it popped into existence. In on a slight overshoot —
      // that settle is what does the catching, without the colour or the motion
      // having to shout. Out sideways, off the stack's own axis, so a dismissal
      // never reads as the toast below it moving up.
      className={`relative flex items-start gap-3 overflow-hidden rounded-tile bg-surface-2 py-3 pl-4 pr-2 shadow-overlay ${
        leaving
          ? "pointer-events-none motion-safe:animate-[toast-out_var(--duration-exit)_var(--ease-in-expo)_forwards]"
          : "pointer-events-auto motion-safe:animate-[toast-in_var(--duration-base)_var(--ease-spring)_both]"
      }`}
    >
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${tone.rule}`} />
      <Icon name={tone.icon} size={18} className={`mt-px ${tone.text}`} />
      <div className="min-w-0 flex-1">
        <p className={`text-micro font-semibold uppercase tracking-[0.08em] ${tone.text}`}>
          {tone.label}
        </p>
        <p className="mt-0.5 truncate text-small font-semibold text-ink">{toast.title}</p>
        {toast.detail && (
          <p className="mt-0.5 truncate text-caption text-ink-dim">{toast.detail}</p>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition duration-(--duration-quick) hover:bg-surface-3 hover:text-ink motion-safe:active:scale-90"
      >
        <Icon name="close" size={15} />
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
