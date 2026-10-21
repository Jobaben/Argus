import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { SURFACE, usePresence, useSurfaceMotion } from "./presence";

export interface MoreItem {
  id: string;
  label: string;
  href: string;
  /** Attention count, drawn as the nav bar draws it; hidden when 0/absent. */
  badge?: number;
}

/** The nav bar's attention count: violet, the colour of "waiting on you". */
function Count({ n }: { n: number }) {
  return (
    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-await/18 px-1.5 text-micro font-semibold leading-none text-await">
      {n}
    </span>
  );
}

function Item({
  item,
  activeId,
  onPick,
}: {
  item: MoreItem;
  activeId?: string;
  onPick: () => void;
}) {
  const current = item.id === activeId;
  return (
    <a
      href={item.href}
      role="menuitem"
      aria-current={current ? "page" : undefined}
      onClick={onPick}
      // Focus is the eye's ring, inset, not just a background tint: a
      // `surface-3` row on a `surface-2` menu was a keyboard user's only cue
      // and it was nearly invisible.
      className={`flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm transition duration-(--duration-quick) hover:bg-surface-3 hover:text-ink focus:bg-surface-3 focus:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-eye/70 motion-safe:active:scale-[0.98] ${
        current ? "text-ink" : "text-ink-dim"
      }`}
    >
      {item.label}
      <span className="flex items-center gap-2">
        {item.badge != null && item.badge > 0 && <Count n={item.badge} />}
        {current && <Icon name="check" size={14} className="text-eye" />}
      </span>
    </a>
  );
}

export function MoreMenu({
  items,
  lead = [],
  active,
  activeId,
}: {
  items: MoreItem[];
  /**
   * Primary destinations that did not fit the bar, listed first and set apart
   * from `items` by a rule. Their badges add up on the trigger, so a count
   * that left the bar is still on screen.
   */
  lead?: MoreItem[];
  active: boolean;
  /** Id of the currently-active overflow route, marked aria-current in the menu. */
  activeId?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { present, exited } = usePresence(open);
  // `top right` is the corner the menu hangs from, so it grows out of the button
  // that opened it rather than out of an anonymous point above the page. Origin
  // is information: it says *this* control produced this surface.
  const motionRef = useSurfaceMotion<HTMLDivElement>(open, SURFACE.menu, exited, "top right");
  const setMenu = (node: HTMLDivElement | null) => {
    menuRef.current = node;
    motionRef(node);
  };

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

  const leadCount = lead.reduce((n, it) => n + (it.badge ?? 0), 0);

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
        className={`flex h-8 shrink-0 items-center gap-1 rounded-control pl-2.5 pr-2 text-sm transition duration-(--duration-quick) motion-safe:active:scale-[0.97] ${
          active || open
            ? "bg-surface-2 text-ink"
            : "text-ink-dim hover:bg-surface-2/60 hover:text-ink"
        }`}
      >
        More
        {leadCount > 0 && !open && (
          <span className="ml-1">
            <Count n={leadCount} />
          </span>
        )}
        <Icon
          name="chevron-down"
          size={14}
          className={`transition-transform duration-(--duration-base) ease-(--ease-out-expo) ${open ? "rotate-180" : ""}`}
        />
      </button>
      {present && (
        <>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => close(false)}
            className="fixed inset-0 z-10 cursor-default"
            // The dismiss shield must stop taking clicks the moment the menu is
            // closing, or a click aimed at what is behind it lands on a shield
            // for a surface that is already leaving.
            inert={!open}
            aria-hidden
          />
          <div
            ref={setMenu}
            role="menu"
            aria-label="More pages"
            onKeyDown={onMenuKeyDown}
            inert={!open}
            aria-hidden={open ? undefined : true}
            className="absolute right-0 z-20 mt-1.5 min-w-48 rounded-tile bg-surface-2 p-1.5 shadow-overlay"
          >
            {lead.map((it) => (
              <Item key={it.id} item={it} activeId={activeId} onPick={() => close(false)} />
            ))}
            {lead.length > 0 && items.length > 0 && (
              <div role="separator" className="mx-1 my-1.5 h-px bg-line" />
            )}
            {items.map((it) => (
              <Item key={it.id} item={it} activeId={activeId} onPick={() => close(false)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
