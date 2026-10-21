import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { useCountUp } from "./motion";

const TONE = {
  ink: "text-ink",
  run: "text-run",
  fail: "text-fail",
  live: "text-eye",
  queue: "text-queue",
  ok: "text-ok",
  await: "text-await",
} as const;

const RULE = {
  ink: "bg-ink-faint/40",
  run: "bg-run",
  fail: "bg-fail",
  live: "bg-eye",
  queue: "bg-queue",
  ok: "bg-ok",
  await: "bg-await",
} as const;

/**
 * A counter tile whose value *moves* when it changes.
 *
 * On a live board the numbers are the summary — "2 failing" becoming "3 failing"
 * is the entire message, and a silent swap is easy to miss between glances.
 * Rolling the digits makes the change visible without a notification, and
 * {@link useCountUp} snaps rather than rolls where animating would hurt (first
 * paint, order-of-magnitude jumps, reduced motion).
 *
 * A tone is a claim — red says "something failed" — so it is only made when the
 * count is non-zero. A row of red and amber zeros was a dashboard shouting about
 * nothing; a zero is neutral, and the coloured tile is the one to look at.
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
  const zero = value === 0;
  const active = zero ? "ink" : tone;
  const body = (
    <>
      <span
        aria-hidden="true"
        className={`absolute inset-y-3 left-0 w-[3px] rounded-r-full transition-colors duration-(--duration-base) ${
          zero || tone === "ink" ? "bg-transparent" : RULE[tone]
        }`}
      />
      <div
        className={`text-display font-semibold leading-none tracking-tight transition-colors duration-(--duration-base) ${
          zero ? "text-ink-faint" : TONE[active]
        }`}
      >
        {typeof value === "number" ? <CountingValue value={value} /> : value}
      </div>
      <div className={`mt-2 text-caption font-semibold ${selected ? "text-ink" : "text-ink-dim"}`}>
        {label}
      </div>
      {selected && <Icon name="check" size={14} className="absolute right-3 top-3 text-ink" />}
    </>
  );
  // The filter that is on has to be findable at a glance across a row of six:
  // a full-ink border with a ring outside it, a lifted surface, a brighter label
  // and a check, where a slightly different background was all it used to get.
  // Hover never touches a selected tile, so the pointer cannot make it look off.
  const shell = `relative overflow-hidden rounded-tile border px-4 py-3.5 text-left shadow-raised transition-colors duration-(--duration-base) ${
    selected
      ? "border-ink-dim bg-surface-3 ring-2 ring-ink-dim/25"
      : `border-line bg-surface ${onClick ? "hover:border-line-strong hover:bg-surface-2" : ""}`
  }`;

  // A counter that names a subset the reader wants to see is already the control
  // for showing it; making them find a separate filter is a wasted click.
  if (!onClick) return <div className={shell}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={title}
      className={`${shell} cursor-pointer motion-safe:active:scale-[0.98]`}
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
