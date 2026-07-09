import type { ReactNode } from "react";
import { formatMs, formatTokens, formatUsd } from "./format";

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
    return (
      <span className="flex flex-col items-end gap-0.5" title={title}>
        <span className="font-mono text-meter font-bold uppercase tracking-[0.14em] text-ink-faint">
          {label ?? "Total spend"}
        </span>
        <span className="text-glance-sm font-extrabold leading-none text-ink">
          {tokens != null && (
            <>
              {formatTokens(tokens)} <small className={UNIT}>tok</small>
            </>
          )}
          {tokens != null && usd != null && <span className="text-ink-faint"> · </span>}
          {usd != null && (
            <>
              <small className={UNIT}>$</small>
              {formatUsd(usd).slice(1)}
            </>
          )}
        </span>
      </span>
    );
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
