import type { ReactNode, Ref } from "react";

export function Card({
  children,
  className = "",
  ref,
}: {
  children: ReactNode;
  className?: string;
  /** For FLIP registration, so a card in a live list glides when the list
   *  re-orders instead of teleporting. */
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className={`rounded-tile border border-line bg-surface p-4 transition duration-(--duration-quick) hover:border-ink-faint/40 hover:bg-surface-2 ${className}`}
    >
      {children}
    </div>
  );
}
