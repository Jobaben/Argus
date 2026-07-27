import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-tile border border-line bg-surface p-4 transition duration-(--duration-quick) hover:border-ink-faint/40 hover:bg-surface-2 ${className}`}
    >
      {children}
    </div>
  );
}
