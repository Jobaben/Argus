import type { ReactNode } from "react";

export interface Crumb {
  label: string;
  href: string;
}

export function Page({
  title,
  crumbs,
  actions,
  wide = false,
  children,
}: {
  title?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
  /** Board layout: board-scale heading. Width stays capped to match the nav bar. */
  wide?: boolean;
  children: ReactNode;
}) {
  const hasCrumbs = crumbs != null && crumbs.length > 0;
  const hasHeader = title != null || hasCrumbs || actions != null;
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-8">
      {hasHeader && (
        // Wraps rather than overlapping: on a phone the title and its actions
        // (a spend total, a window picker) cannot share one line, and
        // `justify-between` without wrapping let them collide.
        <header className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {crumbs?.map((c) => (
              <span key={c.href} className="flex items-center gap-2 text-sm text-ink-faint">
                <a href={c.href} className="transition hover:text-ink">
                  {c.label}
                </a>
                <span aria-hidden>›</span>
              </span>
            ))}
            {title != null && (
              <h1
                className={`${wide ? "text-board-title" : "text-xl"} font-bold tracking-tight text-ink`}
              >
                {title}
              </h1>
            )}
          </div>
          {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
}
