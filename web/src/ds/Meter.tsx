import type { ReactNode } from "react";
import { formatMs, formatTokens, formatUsd } from "./format";
import { useCountUp } from "./motion";

export interface MeterProps {
  /** Total tokens; null/undefined = unknown (hidden), 0 = reported zero. */
  tokens?: number | null;
  /** Dollar cost; null/undefined = unknown (hidden), 0 = reported zero. */
  usd?: number | null;
  /** Final run duration; shown as the first segment when known. */
  durationMs?: number | null;
  level: "step" | "row" | "board";
  /** Visible label; defaults to "run total" (row) / "Total spend" (board). */
  label?: string;
  /** Border-left divider for when the meter follows other foot items. */
  divider?: boolean;
  title?: string;
}

const VALUE = "font-semibold text-ink-dim";
const UNIT = "text-[0.55em] font-semibold text-ink-faint";

function segments(
  durationMs: number | null | undefined,
  tokens: number | null | undefined,
  usd: number | null | undefined,
): ReactNode[] {
  const parts: ReactNode[] = [];
  if (durationMs != null) {
    parts.push(
      <b key="dur" className={VALUE}>
        {formatMs(durationMs)}
      </b>,
    );
  }
  if (tokens != null) {
    parts.push(
      <span key="tok">
        <b className={VALUE}>{formatTokens(tokens)}</b> tok
      </span>,
    );
  }
  if (usd != null) {
    parts.push(
      <b key="usd" className={VALUE}>
        {formatUsd(usd)}
      </b>,
    );
  }
  return parts.flatMap((p, i) => (i === 0 ? [p] : [" · ", p]));
}

/**
 * The board-level glance total, counted rather than swapped.
 *
 * This is the one number on the page whose *change* is the information: spend
 * ticking up is the whole reason a cost meter exists at all, and replacing "$4.10"
 * with "$4.63" between frames throws that away — you see the new figure and have
 * to remember the old one to know anything happened. `useCountUp` keeps its own
 * rules about when not to (first paint, huge jumps), so a page load is not a slot
 * machine.
 *
 * Split into its own component because the row and step levels must *not* count:
 * a finished step's cost is a fact about the past, and animating a fact reads as
 * the number still being decided.
 */
function BoardMeter({
  tokens,
  usd,
  label,
  title,
}: Pick<MeterProps, "tokens" | "usd" | "label" | "title">) {
  const shownTokens = useCountUp(tokens ?? 0);
  const shownUsd = useCountUp(usd ?? 0);
  return (
    <span className="flex flex-col items-end gap-0.5" title={title}>
      <span className="font-mono text-meter font-bold uppercase tracking-[0.14em] text-ink-faint">
        {label ?? "Total spend"}
      </span>
      <span className="text-glance-sm font-extrabold leading-none text-ink">
        {tokens != null && (
          <>
            {formatTokens(shownTokens)} <small className={UNIT}>tok</small>
          </>
        )}
        {tokens != null && usd != null && <span className="text-ink-faint"> · </span>}
        {usd != null && (
          <>
            <small className={UNIT}>$</small>
            {formatUsd(shownUsd).slice(1)}
          </>
        )}
      </span>
    </span>
  );
}

/** Cost/token meter per the DS run-meter spec: step foot, row header, board glance. */
export function Meter({
  tokens,
  usd,
  durationMs,
  level,
  label,
  divider = false,
  title,
}: MeterProps) {
  if (tokens == null && usd == null && durationMs == null) return null;

  if (level === "board") {
    return <BoardMeter tokens={tokens} usd={usd} label={label} title={title} />;
  }

  const scale = level === "row" ? "text-label" : "text-meter";
  return (
    <span
      className={`inline-flex items-baseline gap-[5px] font-mono ${scale} text-ink-faint${
        divider ? " border-l border-line pl-2" : ""
      }`}
      title={title}
    >
      {level === "row" && (
        <span className="font-bold uppercase tracking-[0.14em]">{label ?? "run total"}</span>
      )}
      <span>{segments(durationMs, tokens, usd)}</span>
    </span>
  );
}
