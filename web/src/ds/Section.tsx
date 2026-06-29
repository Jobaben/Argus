import type { ReactNode } from "react";

export function Section({
  title,
  children,
  className = "",
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mb-8 ${className}`}>
      <h2 className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
        {title}
      </h2>
      {children}
    </section>
  );
}
