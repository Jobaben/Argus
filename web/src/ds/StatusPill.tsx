import { STATUS, type DsStatus, type ColorToken } from "./status";
import { DURATION, useChangeFlash, useSyncedDelay } from "./motion";

const PILL: Record<ColorToken, string> = {
  run: "text-run bg-run/10 border-run/30",
  ok: "text-ok bg-ok/10 border-ok/25",
  fail: "text-fail bg-fail/12 border-fail/35",
  queue: "text-queue bg-queue/10 border-queue/30",
  idle: "text-ink-dim bg-ink-faint/8 border-line-strong",
  await: "text-await bg-await/12 border-await/40",
};

const SIZE = {
  md: "gap-1.5 pl-2 pr-2.5 h-6 text-caption",
  sm: "gap-1 pl-1.5 pr-2 h-5 text-micro",
} as const;

const DOT = {
  md: "h-1.5 w-1.5",
  sm: "h-1.5 w-1.5",
} as const;

/**
 * A status, in words, with its colour and a dot.
 *
 * Sentence case in the brand face rather than tracked monospace capitals: a
 * board has dozens of these, and a wall of shouted mono labels made every one of
 * them equally loud. The colour and the dot carry the category at a glance; the
 * word carries it exactly; and only the states that are *happening* animate —
 * working and awaiting breathe, everything else is still.
 */
export function StatusPill({
  status,
  size = "md",
  label: override,
}: {
  status: DsStatus;
  size?: keyof typeof SIZE;
  /**
   * A more exact word for this status in this place — "Skipped" on a phase the
   * status table can only call idle or stopped. The colour still comes from
   * `status`, so the pill cannot claim a state its tone contradicts.
   */
  label?: string;
}) {
  const { token, label: standard } = STATUS[status];
  const label = override ?? standard;
  const beat = useSyncedDelay(DURATION.pulse);
  // A status change used to be a hard class swap: `working` was simply replaced
  // by `failed`, with nothing in between, so on a board you were left comparing
  // what you see against your memory of a moment ago. Arriving at a *bad* state
  // is the one transition worth marking as an event, so it also gets a single
  // ring — the same gesture `ConnectionPill` uses for going live, in reverse.
  const justFailed = useChangeFlash(status, DURATION.ping) && status === "failed";
  const breathing = status === "await" || status === "working";
  return (
    <span
      className={`relative inline-flex shrink-0 items-center whitespace-nowrap rounded-full border font-semibold leading-none transition-colors duration-(--duration-base) ${SIZE[size]} ${PILL[token]}`}
    >
      {justFailed && (
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full border border-current motion-safe:animate-[ping-ring_var(--duration-ping)_var(--ease-out-expo)]"
        />
      )}
      <span
        aria-hidden="true"
        style={breathing ? { animationDelay: beat } : undefined}
        className={`shrink-0 rounded-full bg-current ${DOT[size]} ${
          breathing ? "animate-[pulse_var(--duration-pulse)_ease-in-out_infinite]" : ""
        }`}
      />
      {label}
    </span>
  );
}
