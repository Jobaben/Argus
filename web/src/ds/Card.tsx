import type { ReactNode, Ref } from "react";

export function Card({
  children,
  className = "",
  interactive = false,
  ref,
}: {
  children: ReactNode;
  className?: string;
  /**
   * Whether the card itself is clickable (it is, or wraps, a link). Only then
   * does it answer the pointer: a hover state on something that does nothing
   * is a promise the card cannot keep.
   */
  interactive?: boolean;
  /** For FLIP registration, so a card in a live list glides when the list
   *  re-orders instead of teleporting. */
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className={`rounded-tile border border-line bg-surface p-4 shadow-raised ${
        interactive
          ? "transition duration-(--duration-quick) hover:border-line-strong hover:bg-surface-2"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
