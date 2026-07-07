import { useEffect, useRef, useState } from "react";

export interface MoreItem {
  id: string;
  label: string;
  href: string;
}

export function MoreMenu({
  items,
  active,
  activeId,
}: {
  items: MoreItem[];
  active: boolean;
  /** Id of the currently-active overflow route, marked aria-current in the menu. */
  activeId?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // When the menu opens, move focus to the first item so keyboard users land
  // inside it; Escape closes and returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLAnchorElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const links = Array.from(
      menuRef.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? [],
    );
    const idx = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      // Tabbing out of the menu closes it (without stealing focus, so focus
      // moves naturally to the next element).
      close(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      links[Math.min(links.length - 1, idx + 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (idx <= 0) close();
      else links[idx - 1]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      links[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      links[links.length - 1]?.focus();
    }
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`shrink-0 rounded-md px-2.5 py-1.5 text-sm font-medium transition ${
          active || open ? "bg-surface-2 text-ink" : "text-ink-dim hover:text-ink"
        }`}
      >
        ⋯ More
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => close(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            ref={menuRef}
            role="menu"
            aria-label="More pages"
            onKeyDown={onMenuKeyDown}
            className="absolute right-0 z-20 mt-1 min-w-40 rounded-lg border border-line bg-surface p-1 shadow-lg"
          >
            {items.map((it) => (
              <a
                key={it.id}
                href={it.href}
                role="menuitem"
                aria-current={it.id === activeId ? "page" : undefined}
                onClick={() => close(false)}
                className={`block rounded-md px-3 py-1.5 text-sm transition hover:bg-surface-2 hover:text-ink focus:bg-surface-2 focus:text-ink focus:outline-none ${
                  it.id === activeId ? "text-ink" : "text-ink-dim"
                }`}
              >
                {it.label}
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
