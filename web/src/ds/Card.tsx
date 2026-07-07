import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-tile border border-line bg-surface p-4 transition hover:border-ink-faint/40 ${className}`}
    >
      {children}
    </div>
  );
}
