export function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.round(ms / 60_000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * A cadence in minutes reduced to its largest whole unit: 360 → "6h", 1440 →
 * "1d", 90 → "90m".
 *
 * "every 360 min" is arithmetic the reader has to finish; "every 6h" is the
 * thing they meant when they typed it.
 */
export function formatCadence(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Human-readable elapsed time for millisecond-scale run metrics. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Ticking clock for a live elapsed duration: "04:12", "1:02:03". */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Dollar cost with enough precision for sub-cent agent runs. */
export function formatUsd(v: number): string {
  // Sub-cent amounts are real — a cheap step can cost $0.0004 — so they get four
  // decimals. Exactly zero does not: "$0.0000" reads as a precision claim about
  // nothing, and it is what the spend meter shows before the first run of the day.
  if (v === 0) return "$0.00";
  return v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

/** Compact token count: 1234 → "1.2k", 2500000 → "2.5M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** "12.3k tok · $0.42" from whichever of the two metrics is known; null when neither is. */
export function formatCost(
  tokens: number | null | undefined,
  usd: number | null | undefined,
): string | null {
  const parts: string[] = [];
  if (tokens != null) parts.push(`${formatTokens(tokens)} tok`);
  if (usd != null) parts.push(formatUsd(usd));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface RunLogField {
  label: string;
  value: string;
}

/**
 * A run log is either the CLI's `--output-format json` result envelope (which we
 * surface as readable fields, never raw JSON) or, when the process crashed before
 * emitting one, plain diagnostic text we must not discard.
 */
export type ParsedRunLog =
  | { kind: "envelope"; fields: RunLogField[]; truncated: boolean }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "empty" };

const TRUNCATION_MARKER = "…(truncated)…";

/** The result envelope is the final JSON object on stdout, emitted as its own
 * line. Try the whole payload first, then each brace-led line from last to first
 * so leading stderr noise can't defeat the parse. */
function extractEnvelope(text: string): Record<string, unknown> | null {
  const candidates = [text];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimStart().startsWith("{")) candidates.push(lines[i]);
  }
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not this candidate; try the next
    }
  }
  return null;
}

export function parseRunLog(raw: string): ParsedRunLog {
  let truncated = false;
  let text = raw ?? "";
  if (text.startsWith(TRUNCATION_MARKER)) {
    truncated = true;
    text = text.slice(TRUNCATION_MARKER.length);
  }
  text = text.trim();
  if (!text) return { kind: "empty" };

  const env = extractEnvelope(text);
  if (!env) return { kind: "text", text, truncated };

  const fields: RunLogField[] = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value != null && value !== "") fields.push({ label, value });
  };
  const num = (k: string): number | undefined =>
    typeof env[k] === "number" ? (env[k] as number) : undefined;

  const subtype = typeof env.subtype === "string" ? env.subtype : undefined;
  push("Status", env.is_error ? `error${subtype ? ` (${subtype})` : ""}` : (subtype ?? "success"));
  if (env.api_error_status != null) push("API error", String(env.api_error_status));
  const dur = num("duration_ms");
  if (dur != null) push("Duration", formatMs(dur));
  const api = num("duration_api_ms");
  if (api != null) push("API time", formatMs(api));
  const ttft = num("ttft_ms");
  if (ttft != null) push("Time to first token", formatMs(ttft));
  const turns = num("num_turns");
  if (turns != null) push("Turns", String(turns));
  const cost = num("total_cost_usd");
  if (cost != null) push("Cost", `$${cost.toFixed(4)}`);
  const usage = env.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === "object") {
    const i = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
    const o = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
    if (i != null || o != null) push("Tokens", `${i ?? 0} in / ${o ?? 0} out`);
  }
  return { kind: "envelope", fields, truncated };
}

/**
 * The largest sensible unit of a positive duration: "45s", "12m", "2h 10m",
 * "3d 4h". Shared by the countdown and relative-time formatters so a schedule
 * reads the same whether it is 5 minutes away or 5 minutes late.
 */
function coarseDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/**
 * A countdown to a future instant: "in 45s", "in 12m", "in 2h 10m", "in 3d 4h".
 *
 * Never renders a negative duration. A slot that has passed but not fired yet
 * reads "due now" — the raw arithmetic is what produced the "-7138s ago" that
 * used to appear on late monitors.
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "due now";
  return `in ${coarseDuration(ms)}`;
}

/**
 * Relative time in **either** direction: "3h ago" for the past, "in 3h" for the
 * future, "just now" for either side of the present moment.
 *
 * The bidirectionality is the point. The same component renders "last run" and
 * "next expected", and treating every instant as past turned a monitor's next
 * slot into `-7138s ago` — a number that looks like corruption and taught the
 * reader to distrust the row.
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const delta = then - now;
  if (Math.abs(delta) < 10_000) return "just now";
  return delta > 0 ? `in ${coarseDuration(delta)}` : `${coarseDuration(-delta)} ago`;
}
