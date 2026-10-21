import type { ReactNode } from "react";

export function Section({
  title,
  children,
  className = "",
  action,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  /** A control that belongs to the section, set at the heading's far end. */
  action?: ReactNode;
}) {
  return (
    <section className={`mb-10 ${className}`}>
      <div className="mb-3 flex min-h-6 items-center justify-between gap-3">
        <h2 className="eyebrow">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
