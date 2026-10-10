import { useEffect, useId, useRef, useState, type ReactNode } from "react";

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
  const panelId = useId();

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
            : "inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-line font-mono text-[10px] font-bold leading-none text-ink-faint transition duration-(--duration-quick) hover:border-eye/50 hover:text-ink aria-expanded:border-eye/60 aria-expanded:text-eye"
        }
      >
        {trigger ?? "?"}
      </button>
      {open && (
        <span
          id={panelId}
          role="dialog"
          aria-label={title}
          className={`absolute top-full z-40 mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-panel border border-line bg-surface p-3.5 text-left text-[13px] font-normal normal-case leading-relaxed tracking-normal text-ink-dim shadow-[0_24px_60px_-24px_rgb(0_0_0/0.9)] motion-safe:animate-[fade-in_var(--duration-quick)_ease-out] ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-eye">
            {title}
          </span>
          <span>{children}</span>
          {note && (
            <span className="border-l-2 border-eye/40 pl-2.5 text-[12.5px] text-ink">{note}</span>
          )}
          {footer && <span className="font-mono text-[11px] text-ink-faint">{footer}</span>}
        </span>
      )}
    </span>
  );
}
