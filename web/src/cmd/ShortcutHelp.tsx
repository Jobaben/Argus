import { Fragment, useEffect, useMemo, useRef } from "react";
import { containTab } from "./containTab";
import { formatKeys, type Binding } from "./keys";
import { Icon, SURFACE, usePresence, useSurfaceMotion } from "../ds";

/**
 * The `?` overlay.
 *
 * It renders the *same* array the key layer dispatches from, filtered only by
 * `hidden` and each binding's own `when` guard. So a shortcut that exists is
 * listed, a shortcut that is currently unavailable (needs admin) is not
 * advertised, and there is no second list to forget to update.
 */
export function ShortcutHelp({
  open,
  onClose,
  bindings,
}: {
  open: boolean;
  onClose: () => void;
  bindings: Binding[];
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const platform =
    typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
  const { present, exited } = usePresence(open);
  const scrimRef = useSurfaceMotion<HTMLDivElement>(open, SURFACE.scrim);
  const dialogRef = useSurfaceMotion<HTMLDivElement>(open, SURFACE.rise, exited);

  const groups = useMemo(() => {
    const visible = bindings.filter((b) => !b.hidden && b.when?.() !== false);
    const byGroup = new Map<string, Binding[]>();
    for (const binding of visible) {
      const list = byGroup.get(binding.group);
      if (list) list.push(binding);
      else byGroup.set(binding.group, [binding]);
    }
    return [...byGroup.entries()];
  }, [bindings]);

  useEffect(() => {
    if (!open) {
      restoreFocus.current?.focus?.();
      return;
    }
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => closeRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!present) return null;

  return (
    <div
      ref={scrimRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 px-4 backdrop-blur-sm"
      inert={!open}
      aria-hidden={open ? undefined : true}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        // Tab moves between Close and the list, never out to the page behind
        // the scrim. Focusable but not tabbable, so a click on the heading
        // keeps focus in the sheet.
        tabIndex={-1}
        onKeyDown={containTab}
        className="w-full max-w-[600px] overflow-hidden rounded-panel bg-surface-2 shadow-overlay focus:outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2
            id="shortcut-help-title"
            className="flex items-center gap-2.5 text-heading font-semibold text-ink"
          >
            <Icon name="keyboard" size={18} className="text-ink-dim" />
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="-mr-1.5 flex h-8 items-center gap-1.5 rounded-control px-1.5 text-ink-dim transition hover:bg-surface-3 hover:text-ink motion-safe:active:scale-[0.97]"
          >
            <span aria-hidden="true" className="kbd hidden sm:inline-flex">
              Esc
            </span>
            <Icon name="close" size={18} />
          </button>
        </div>
        {/* A tab stop of its own. On a short window the list scrolls, and
            the arrow keys only scroll what has focus. The browser would make
            a scroller a stop by itself, but containTab steers Tab through
            real controls only, so the list says it is one. The ring is drawn
            inside, where the sheet's rounded clip cannot cut it off. */}
        <div
          role="region"
          aria-label="All shortcuts"
          tabIndex={0}
          className="grid max-h-[68vh] gap-x-8 overflow-y-auto rounded-b-panel px-5 py-5 focus-visible:-outline-offset-2 sm:grid-cols-2"
        >
          {groups.map(([group, items]) => (
            <section key={group} className="mb-6">
              <h3 className="eyebrow mb-2.5">{group}</h3>
              <dl className="flex flex-col gap-2">
                {items.map((binding) => (
                  <div key={binding.keys} className="flex items-center gap-3">
                    {/* dt before dd, as a description list requires; the keys are
                        drawn on the right by order, not by source position. */}
                    <dt className="order-2 flex shrink-0 items-center gap-1 text-small">
                      {/* A chord is a sequence, not a combination: "G then C"
                          says press one and then the other, where two caps
                          side by side read as hold both. */}
                      {formatKeys(binding.keys, platform).map((cap, i) => (
                        <Fragment key={i}>
                          {i > 0 && <span className="text-caption text-ink-faint">then</span>}
                          <kbd className="kbd">{cap}</kbd>
                        </Fragment>
                      ))}
                    </dt>
                    <dd className="order-1 min-w-0 flex-1 text-small text-ink-dim">
                      {binding.label}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
