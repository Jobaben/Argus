import { describe, it, expect } from "vitest";
import {
  formatCost,
  formatDuration,
  formatMs,
  formatTokens,
  formatUsd,
  parseRunLog,
  sparklinePoints,
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

describe("sparklinePoints", () => {
  it("maps a flat series to the vertical mid-line", () => {
    expect(sparklinePoints([5, 5, 5], 100, 26)).toBe("0,13 50,13 100,13");
  });
  it("puts the max at the top (y=0) and min at the bottom", () => {
    expect(sparklinePoints([0, 10], 100, 26)).toBe("0,26 100,0");
  });
  it("returns empty string for empty input", () => {
    expect(sparklinePoints([], 100, 26)).toBe("");
  });
});
