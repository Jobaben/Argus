import { describe, it, expect } from "vitest";
import {
  formatCadence,
  formatCost,
  formatDuration,
  formatElapsed,
  formatMs,
  formatTokens,
  formatUsd,
  formatCountdown,
  formatRelativeTime,
  parseRunLog,
} from "./format";

describe("formatUsd", () => {
  it("renders cents with two decimals", () => {
    expect(formatUsd(1.5)).toBe("$1.50");
  });
  it("renders sub-cent values with four decimals", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });
});

describe("formatTokens", () => {
  it("compacts thousands and millions", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("formatCost", () => {
  it("joins tokens and dollars", () => {
    expect(formatCost(1500, 0.42)).toBe("1.5k tok · $0.42");
  });
  it("renders whichever metric is known", () => {
    expect(formatCost(1500, null)).toBe("1.5k tok");
    expect(formatCost(null, 0.42)).toBe("$0.42");
  });
  it("is null when neither metric is known", () => {
    expect(formatCost(null, undefined)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("renders minutes under an hour", () => {
    expect(formatDuration(12 * 60_000)).toBe("12m");
  });
  it("renders hours and minutes under a day", () => {
    expect(formatDuration((7 * 60 + 41) * 60_000)).toBe("7h 41m");
  });
  it("renders days and hours past a day", () => {
    expect(formatDuration((2 * 24 * 60 + 14 * 60) * 60_000)).toBe("2d 14h");
  });
  it('returns "now" for non-positive input', () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(-5000)).toBe("now");
  });
});

describe("formatMs", () => {
  it("renders sub-second values in ms", () => {
    expect(formatMs(850)).toBe("850ms");
  });
  it("renders seconds with one decimal under a minute", () => {
    expect(formatMs(27287)).toBe("27.3s");
  });
  it("renders minutes and seconds past a minute", () => {
    expect(formatMs(90000)).toBe("1m 30s");
  });
  it("returns a dash for invalid input", () => {
    expect(formatMs(-1)).toBe("—");
    expect(formatMs(Number.NaN)).toBe("—");
  });
});

describe("formatUsd", () => {
  it("shows two decimals for a cent or more", () => {
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(0.42)).toBe("$0.42");
    expect(formatUsd(118.4249)).toBe("$118.42");
  });

  it("shows four decimals for a real sub-cent cost", () => {
    expect(formatUsd(0.0004)).toBe("$0.0004");
    expect(formatUsd(0.009)).toBe("$0.0090");
  });

  it("shows plain zero rather than a false precision claim", () => {
    // The spend meter renders this before the first run of the day.
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("formatCountdown", () => {
  it("counts down in the largest sensible unit", () => {
    expect(formatCountdown(45_000)).toBe("in 45s");
    expect(formatCountdown(12 * 60_000)).toBe("in 12m");
    expect(formatCountdown(2 * 3_600_000 + 10 * 60_000)).toBe("in 2h 10m");
    expect(formatCountdown(3 * 3_600_000)).toBe("in 3h");
    expect(formatCountdown(3 * 86_400_000 + 4 * 3_600_000)).toBe("in 3d 4h");
    expect(formatCountdown(2 * 86_400_000)).toBe("in 2d");
  });

  it("never renders a negative duration", () => {
    // A slot that has passed but not fired used to render "-7138s ago".
    expect(formatCountdown(0)).toBe("due now");
    expect(formatCountdown(-7_138_000)).toBe("due now");
  });

  it("degrades on a non-finite input", () => {
    expect(formatCountdown(Number.NaN)).toBe("—");
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("rounds a sub-second wait up to a second, never to zero", () => {
    expect(formatCountdown(400)).toBe("in 1s");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-07T12:00:00.000Z").getTime();
  const at = (ms: number) => new Date(now + ms).toISOString();

  it("reads the past as 'ago'", () => {
    expect(formatRelativeTime(at(-45_000), now)).toBe("45s ago");
    expect(formatRelativeTime(at(-12 * 60_000), now)).toBe("12m ago");
    expect(formatRelativeTime(at(-3 * 3_600_000), now)).toBe("3h ago");
    expect(formatRelativeTime(at(-2 * 86_400_000), now)).toBe("2d ago");
  });

  it("reads the future as 'in', instead of a negative 'ago'", () => {
    // The regression: a monitor's next expected slot rendered "-7138s ago".
    expect(formatRelativeTime(at(45_000), now)).toBe("in 45s");
    expect(formatRelativeTime(at(7_138_000), now)).toBe("in 1h 58m");
    expect(formatRelativeTime(at(50_328_000), now)).toBe("in 13h 58m");
  });

  it("collapses either side of the present into 'just now'", () => {
    expect(formatRelativeTime(at(0), now)).toBe("just now");
    expect(formatRelativeTime(at(-5_000), now)).toBe("just now");
    expect(formatRelativeTime(at(5_000), now)).toBe("just now");
  });

  it("degrades on a missing or unparseable timestamp", () => {
    expect(formatRelativeTime(null, now)).toBe("—");
    expect(formatRelativeTime(undefined, now)).toBe("—");
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });
});

describe("parseRunLog", () => {
  const envelope = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    duration_ms: 27287,
    duration_api_ms: 22592,
    ttft_ms: 2190,
    num_turns: 4,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 12, output_tokens: 340 },
    result: "I've got the context…",
  });

  it("parses a success envelope into human-readable fields, never the result text", () => {
    const parsed = parseRunLog(envelope);
    expect(parsed.kind).toBe("envelope");
    if (parsed.kind !== "envelope") throw new Error("expected envelope");
    const byLabel = Object.fromEntries(parsed.fields.map((f) => [f.label, f.value]));
    expect(byLabel.Status).toBe("success");
    expect(byLabel.Duration).toBe("27.3s");
    expect(byLabel.Turns).toBe("4");
    expect(byLabel.Cost).toBe("$0.0123");
    expect(byLabel.Tokens).toBe("12 in / 340 out");
    // The answer text belongs to the result block above, never duplicated here.
    expect(parsed.fields.some((f) => f.value.includes("I've got the context"))).toBe(false);
  });

  it("flags an error envelope and keeps its diagnostic subtype", () => {
    const parsed = parseRunLog(
      JSON.stringify({ subtype: "error_during_execution", is_error: true, api_error_status: 529 }),
    );
    if (parsed.kind !== "envelope") throw new Error("expected envelope");
    const byLabel = Object.fromEntries(parsed.fields.map((f) => [f.label, f.value]));
    expect(byLabel.Status).toBe("error (error_during_execution)");
    expect(byLabel["API error"]).toBe("529");
  });

  it("extracts the envelope even when stderr noise precedes it", () => {
    const parsed = parseRunLog(`some warning on stderr\n${envelope}`);
    expect(parsed.kind).toBe("envelope");
  });

  it("honours the server truncation marker", () => {
    const parsed = parseRunLog(`…(truncated)…\n${envelope}`);
    if (parsed.kind !== "envelope") throw new Error("expected envelope");
    expect(parsed.truncated).toBe(true);
  });

  it("falls back to raw text for non-JSON crash output (failed-case diagnostic)", () => {
    const parsed = parseRunLog("Error: spawn claude ENOENT\n  at onErrorNT");
    expect(parsed.kind).toBe("text");
    if (parsed.kind !== "text") throw new Error("expected text");
    expect(parsed.text).toContain("ENOENT");
  });

  it("reports an empty log as empty (so the view can render nothing)", () => {
    expect(parseRunLog("   ").kind).toBe("empty");
    expect(parseRunLog("").kind).toBe("empty");
  });

  it("preserves the truncation flag even when the remaining log is empty", () => {
    const parsed = parseRunLog("…(truncated)…\n   ");
    expect(parsed.kind).toBe("empty");
  });
});

describe("formatElapsed", () => {
  it("renders mm:ss under an hour", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(252_000)).toBe("04:12");
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe("59:59");
  });
  it("renders h:mm:ss from an hour up", () => {
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });
  it("is defensive about garbage", () => {
    expect(formatElapsed(-5)).toBe("—");
    expect(formatElapsed(Number.NaN)).toBe("—");
  });
});

describe("formatCadence", () => {
  it("reduces a cadence to its largest whole unit", () => {
    expect(formatCadence(360)).toBe("6h");
    expect(formatCadence(1440)).toBe("1d");
    expect(formatCadence(2880)).toBe("2d");
    expect(formatCadence(60)).toBe("1h");
  });
  it("keeps minutes when they do not divide cleanly", () => {
    expect(formatCadence(90)).toBe("90m");
    expect(formatCadence(7)).toBe("7m");
  });
  it("refuses to describe a cadence it does not have", () => {
    // A trigger of a kind without `everyMinutes` reaches this with undefined.
    expect(formatCadence(undefined)).toBe("\u2014");
    expect(formatCadence(null)).toBe("\u2014");
    expect(formatCadence(0)).toBe("\u2014");
    expect(formatCadence(-30)).toBe("\u2014");
    expect(formatCadence(Number.NaN)).toBe("\u2014");
  });
});
