import { STATUS, type DsStatus, type ColorToken } from "./status";
import { DURATION, useChangeFlash, useSyncedDelay } from "./motion";

const PILL: Record<ColorToken, string> = {
  run: "text-run bg-run/12",
  ok: "text-ok bg-ok/12",
  fail: "text-fail bg-fail/14",
  queue: "text-queue bg-queue/12",
  idle: "text-idle bg-idle/12",
  await: "text-await bg-await/14",
};

const SIZE = {
  md: "gap-1.5 px-3 py-1 text-[11px] tracking-[0.13em]",
  sm: "gap-1 px-1.5 py-0.5 text-[9px] tracking-[0.1em]",
} as const;

const DOT = {
  md: "h-1.5 w-1.5 shadow-[0_0_8px_1px_currentColor]",
  sm: "h-1 w-1 shadow-[0_0_6px_1px_currentColor]",
} as const;

export function StatusPill({
  status,
  size = "md",
}: {
  status: DsStatus;
  size?: keyof typeof SIZE;
}) {
  const { token, label } = STATUS[status];
  const beat = useSyncedDelay(DURATION.pulse);
  // A status change used to be a hard class swap: `working` was simply replaced
  // by `failed`, with nothing in between, so on a board you were left comparing
  // what you see against your memory of a moment ago. Arriving at a *bad* state
  // is the one transition worth marking as an event, so it also gets a single
  // ring — the same gesture `ConnectionPill` uses for going live, in reverse.
  const justFailed = useChangeFlash(status, DURATION.ping) && status === "failed";
  return (
    <span
      className={`relative inline-flex items-center rounded-full border border-current font-mono font-bold uppercase transition-colors duration-(--duration-base) ${SIZE[size]} ${PILL[token]}`}
    >
      {justFailed && (
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full border border-current motion-safe:animate-[ping-ring_var(--duration-ping)_var(--ease-out-expo)]"
        />
      )}
      {status === "await" && (
        <span
          style={{ animationDelay: beat }}
          className={`animate-[pulse_var(--duration-pulse)_ease-in-out_infinite] rounded-full bg-current ${DOT[size]}`}
        />
      )}
      {label}
    </span>
  );
}
