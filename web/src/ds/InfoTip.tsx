import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * An explanation on demand: a small `?` (or any inline trigger) that opens a
 * popover with what a term means. Click or Enter/Space opens it; an outside
 * click or Escape closes it, like every other popover in the app. Escape is
 * claimed while open, so dismissing a tip inside a drawer leaves the drawer.
 */
export function InfoTip({
  title,
  children,
  note,
  footer,
  trigger,
  align = "start",
}: {
  title: string;
  children: ReactNode;
  /** A highlighted caveat under the explanation. */
  note?: ReactNode;
  footer?: ReactNode;
  /** Inline content to use as the trigger instead of the `?` button. */
  trigger?: ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  // Keep the panel on screen. It hangs from its trigger at a fixed width, so a
  // trigger near the right edge — a page's actions, the end of a row on a
  // phone — pushed it past the viewport, and one near the bottom opened below
  // the fold. Measured once it is laid out and corrected on the element
  // itself: a nudge sideways, and a flip above the trigger when there is room
  // there and none below. No state, so the correction costs no second render.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!open || !el) return;
    const margin = 12;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const r = el.getBoundingClientRect();
    let dx = 0;
    if (r.right > vw - margin) dx = vw - margin - r.right;
    if (r.left + dx < margin) dx = margin - r.left;
    if (dx !== 0) el.style.translate = `${Math.round(dx)}px 0`;
    const trigger = rootRef.current?.getBoundingClientRect();
    if (trigger && r.bottom > vh - margin && trigger.top - r.height - 8 > margin) {
      el.style.top = "auto";
      el.style.bottom = "100%";
      el.style.marginTop = "0";
      el.style.marginBottom = "0.5rem";
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex align-baseline">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={trigger ? undefined : `What is ${title.toLowerCase()}?`}
        className={
          trigger
            ? "cursor-help rounded-sm text-inherit underline decoration-ink-faint/60 decoration-dotted underline-offset-4 transition duration-(--duration-quick) hover:decoration-eye"
            : // 20px target around a 15px glyph: findable without a magnifier,
              // still small enough to sit beside a heading without competing.
              "-m-0.5 inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full text-ink-faint transition duration-(--duration-quick) hover:text-ink aria-expanded:text-eye"
        }
      >
        {trigger ?? <Icon name="info" size={15} />}
      </button>
      {open && (
        <span
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={title}
          className={`absolute top-full z-40 mt-2 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-tile bg-surface-2 p-4 text-left text-small font-normal normal-case leading-relaxed tracking-normal text-ink-dim shadow-overlay motion-safe:animate-[rise-in_var(--duration-quick)_var(--ease-out-expo)] ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          <span className="text-small font-semibold text-ink">{title}</span>
          <span>{children}</span>
          {note && (
            <span className="border-l-2 border-eye/50 pl-2.5 text-caption text-ink">{note}</span>
          )}
          {footer && <span className="text-caption text-ink-faint">{footer}</span>}
        </span>
      )}
    </span>
  );
}
