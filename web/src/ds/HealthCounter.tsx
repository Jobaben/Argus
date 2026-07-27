import type { ReactNode } from "react";
import { useCountUp } from "./motion";

const TONE = {
  ink: "text-ink",
  run: "text-run",
  fail: "text-fail",
  live: "text-eye",
} as const;

/**
 * A counter tile whose value *moves* when it changes.
 *
 * On a live board the numbers are the summary — "2 failing" becoming "3 failing"
 * is the entire message, and a silent swap is easy to miss between glances.
 * Rolling the digits makes the change visible without a notification, and
 * {@link useCountUp} snaps rather than rolls where animating would hurt (first
 * paint, order-of-magnitude jumps, reduced motion).
 */
export function HealthCounter({
  label,
  value,
  tone = "ink",
  onClick,
  selected = false,
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: keyof typeof TONE;
  /** Makes the tile a filter control. Omit for a read-only counter. */
  onClick?: () => void;
  /** Whether this tile's filter is the active one. */
  selected?: boolean;
  title?: string;
}) {
  const body = (
    <>
      <div className={`text-4xl font-extrabold leading-none ${TONE[tone]}`}>
        {typeof value === "number" ? <CountingValue value={value} /> : value}
      </div>
      <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        {label}
      </div>
    </>
  );
  const shell = `rounded-tile border bg-ground-2 px-5 py-3.5 text-center transition-colors duration-(--duration-base) ${
    selected ? "border-ink-faint/60 ring-1 ring-ink-faint/40" : "border-line"
  }`;

  // A counter that names a subset the reader wants to see is already the control
  // for showing it; making them find a separate filter is a wasted click.
  if (!onClick) return <div className={`${shell} hover:border-ink-faint/30`}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={title}
      className={`${shell} cursor-pointer hover:border-ink-faint/50`}
    >
      {body}
    </button>
  );
}

/**
 * Only whole numbers roll. Mid-animation the value is fractional, so it is
 * rounded for display — and the final frame is the exact input, so a counter
 * never settles on a rounded lie.
 */
function CountingValue({ value }: { value: number }) {
  const shown = useCountUp(value);
  return <>{Number.isFinite(shown) ? Math.round(shown) : value}</>;
}
