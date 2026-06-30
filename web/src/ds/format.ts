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

/** Human-readable elapsed time for millisecond-scale run metrics. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
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

export function sparklinePoints(
  values: number[],
  width = 100,
  height = 26,
): string {
  const n = values.length;
  if (n === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((v, i) => {
      const x = n === 1 ? 0 : (i / (n - 1)) * width;
      // y inverted: max -> 0 (top), min -> height (bottom); flat -> midline
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${round(x)},${round(y)}`;
    })
    .join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
