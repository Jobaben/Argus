import { useEffect, useMemo, useRef } from "react";
import { formatKeys, type Binding } from "./keys";
import { SURFACE, usePresence, useSurfaceMotion } from "../ds";

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
        className="w-full max-w-[560px] overflow-hidden rounded-panel border border-line bg-surface shadow-[0_24px_80px_-12px_rgb(0_0_0/0.8)]"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="shortcut-help-title" className="text-sm font-bold text-ink">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink motion-safe:active:scale-[0.97]"
          >
            Esc
          </button>
        </div>
        <div className="max-h-[68vh] overflow-y-auto px-5 py-4">
          {groups.map(([group, items]) => (
            <section key={group} className="mb-5 last:mb-0">
              <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                {group}
              </h3>
              <dl className="flex flex-col gap-1.5">
                {items.map((binding) => (
                  <div key={binding.keys} className="flex items-baseline gap-3">
                    <dt className="flex shrink-0 gap-1">
                      {formatKeys(binding.keys, platform).map((cap, i) => (
                        <kbd
                          key={i}
                          className="min-w-[1.75rem] rounded border border-line bg-ground-2 px-1.5 py-0.5 text-center font-mono text-[11px] text-ink-dim"
                        >
                          {cap}
                        </kbd>
                      ))}
                    </dt>
                    <dd className="min-w-0 flex-1 text-[13px] text-ink-dim">{binding.label}</dd>
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
