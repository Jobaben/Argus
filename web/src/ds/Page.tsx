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
  /** Full-width board layout: no max-width cap, board-scale heading. */
  wide?: boolean;
  children: ReactNode;
}) {
  const hasCrumbs = crumbs != null && crumbs.length > 0;
  const hasHeader = title != null || hasCrumbs || actions != null;
  return (
    <div className={`${wide ? "" : "mx-auto max-w-[1600px]"} px-6 py-8`}>
      {hasHeader && (
        <header className="mb-6 flex items-start justify-between gap-4">
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
