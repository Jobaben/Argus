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
}: {
  label: string;
  value: ReactNode;
  tone?: keyof typeof TONE;
}) {
  return (
    <div className="rounded-tile border border-line bg-ground-2 px-5 py-3.5 text-center transition-colors duration-(--duration-base) hover:border-ink-faint/30">
      <div className={`text-4xl font-extrabold leading-none ${TONE[tone]}`}>
        {typeof value === "number" ? <CountingValue value={value} /> : value}
      </div>
      <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        {label}
      </div>
    </div>
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
