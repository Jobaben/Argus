import { describe, it, expect } from "vitest";
import { ATTENTION_KINDS, attentionHref } from "./attentionKinds";

describe("attentionHref", () => {
  it("deep-links a gate to its instance's review drawer", () => {
    expect(attentionHref({ kind: "gate-waiting", id: "run 7/a" })).toBe("#/command/run%207%2Fa");
  });

  it("opens an anomaly's run, and the Watchtower when its id names none", () => {
    expect(attentionHref({ kind: "anomaly", id: "schedule:s1|cost|r9" })).toBe("#/run/r9");
    expect(attentionHref({ kind: "anomaly", id: "a1" })).toBe("#/health/watchtower");
    expect(attentionHref({ kind: "anomaly", id: "schedule:s1|cost|" })).toBe("#/health/watchtower");
  });

  it("sends every other kind to the page its table entry names", () => {
    expect(attentionHref({ kind: "monitor-down", id: "s1" })).toBe("#/health");
    expect(attentionHref({ kind: "monitor-failing", id: "s1" })).toBe("#/health");
    expect(attentionHref({ kind: "issue-open", id: "fp" })).toBe("#/issues");
  });
});

describe("ATTENTION_KINDS", () => {
  it("names monitors the way the Health page labels their statuses", () => {
    expect(ATTENTION_KINDS["monitor-down"].label).toBe("Monitor down");
    expect(ATTENTION_KINDS["monitor-failing"].label).toBe("Monitor failing");
  });
});
