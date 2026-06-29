import type { ReactNode } from "react";

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-tile border border-dashed border-line px-6 py-16 text-center text-ink-faint">
      {children}
    </div>
  );
}
