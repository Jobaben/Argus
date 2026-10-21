import type { ReactNode } from "react";
import { Icon } from "./Icon";

export interface Crumb {
  label: string;
  href: string;
}

export function Page({
  title,
  subtitle,
  crumbs,
  actions,
  wide = false,
  anchor,
  children,
}: {
  title?: ReactNode;
  /**
   * One line under the title saying what the page is for. Pages used to open on
   * a paragraph of explanation that pushed the content below the fold; the
   * sentence that orients a first-time reader goes here, and the rest goes into
   * an `InfoTip` beside it.
   */
  subtitle?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
  /** Board layout: board-scale heading. Width stays capped to match the nav bar. */
  wide?: boolean;
  /**
   * A `view-transition-name` for the heading, shared with the tile or row this
   * page was opened from — so that element visibly *becomes* this page's title
   * instead of the two crossfading past each other. Pass the name built by
   * `transitionName()`; both sides must agree, and only one of them can ever be
   * on screen at a time.
   */
  anchor?: string;
  children: ReactNode;
}) {
  const hasCrumbs = crumbs != null && crumbs.length > 0;
  const hasHeader = title != null || hasCrumbs || actions != null;
  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-16 pt-6 sm:px-6 sm:pt-8">
      {hasHeader && (
        // Wraps rather than overlapping: on a phone the title and its actions
        // (a spend total, a window picker) cannot share one line, and
        // `justify-between` without wrapping let them collide.
        <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 sm:mb-8">
          <div className="min-w-0">
            {hasCrumbs && (
              <nav aria-label="Breadcrumb" className="mb-1.5 flex flex-wrap items-center gap-1">
                {crumbs.map((c) => (
                  <span key={c.href} className="flex items-center gap-1 text-small text-ink-faint">
                    <a
                      href={c.href}
                      className="rounded-sm transition duration-(--duration-quick) hover:text-ink"
                    >
                      {c.label}
                    </a>
                    <Icon name="chevron-right" size={13} className="text-ink-faint/70" />
                  </span>
                ))}
              </nav>
            )}
            {title != null && (
              <h1
                style={anchor ? { viewTransitionName: anchor } : undefined}
                className={`${wide ? "text-board-title" : "text-display"} min-w-0 break-words font-semibold text-ink`}
              >
                {title}
              </h1>
            )}
            {subtitle != null && (
              <p className="mt-1.5 max-w-3xl text-small text-ink-dim">{subtitle}</p>
            )}
          </div>
          {actions != null && (
            // `min-w-0`, not `shrink-0`: actions wrap within the header on a
            // phone instead of forcing it wider than the screen.
            <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      {children}
    </div>
  );
}
