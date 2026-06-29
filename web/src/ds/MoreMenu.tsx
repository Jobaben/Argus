import { useState } from "react";

export interface MoreItem {
  id: string;
  label: string;
  href: string;
}

export function MoreMenu({ items, active }: { items: MoreItem[]; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
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
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1 min-w-40 rounded-lg border border-line bg-surface p-1 shadow-lg"
          >
            {items.map((it) => (
              <a
                key={it.id}
                href={it.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="block rounded-md px-3 py-1.5 text-sm text-ink-dim transition hover:bg-surface-2 hover:text-ink"
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
