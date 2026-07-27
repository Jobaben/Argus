import { useEffect, useRef, type ReactNode } from "react";

/**
 * A right-edge slide-over.
 *
 * The board's whole value is peripheral vision — a dozen pipelines in one
 * glance. Navigating away to inspect one step throws that away and makes
 * "check the failing step, then look at the others" a round trip through the
 * router. A drawer keeps the board on screen behind it, so the context you were
 * reading is still there when you close it.
 *
 * Mounted only while open (see the `open` guard at the bottom), so its content
 * starts fresh each time rather than needing a reset effect.
 */
function Panel({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );

  useEffect(() => {
    const raf = requestAnimationFrame(() => closeRef.current?.focus());
    const restore = restoreFocus.current;
    return () => {
      cancelAnimationFrame(raf);
      restore?.focus?.();
    };
  }, []);

  // Tab must not walk out of an aria-modal dialog into the page behind it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-ground/60 backdrop-blur-[2px] motion-safe:animate-[fade-in_var(--duration-quick)_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Details"}
        onKeyDown={onKeyDown}
        className="flex h-full w-full max-w-[520px] flex-col border-l border-line bg-surface shadow-[-24px_0_80px_-24px_rgb(0_0_0/0.9)] motion-safe:animate-[slide-in-right_var(--duration-base)_var(--ease-out-expo)]"
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-[15px] font-bold leading-tight text-ink">{title}</h2>
            {subtitle && (
              <p className="mt-1 break-words font-mono text-[11px] text-ink-faint">{subtitle}</p>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim transition duration-(--duration-quick) hover:text-ink"
          >
            Esc
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer(props: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { open, ...rest } = props;
  return open ? <Panel {...rest} /> : null;
}
