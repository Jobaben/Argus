import { describe, it, expect } from "vitest";
import { detectTransitions, snapshotStatuses } from "./detectTransitions";
import type { Agent, AgentStatus } from "../types";

function agent(short: string, status: AgentStatus, name = short): Agent {
  return {
    short,
    sessionId: null,
    name,
    status,
    tempo: null,
    detail: null,
    result: null,
    template: null,
    cwd: null,
    cliVersion: null,
    inFlight: null,
    createdAt: null,
    updatedAt: "2026-07-09T00:00:00Z",
    firstTerminalAt: null,
    live: false,
    pid: null,
  };
}

describe("detectTransitions", () => {
  it("suppresses everything on the baseline (null prev)", () => {
    const next = [agent("a", "done"), agent("b", "failed"), agent("c", "working")];
    expect(detectTransitions(null, next)).toEqual([]);
  });

  it("emits when an agent transitions into done", () => {
    const prev = snapshotStatuses([agent("a", "working")]);
    const events = detectTransitions(prev, [agent("a", "done", "Fixer")]);
    expect(events).toEqual([
      { short: "a", name: "Fixer", status: "done", at: "2026-07-09T00:00:00Z" },
    ]);
  });

  it("emits when an agent transitions into failed", () => {
    const prev = snapshotStatuses([agent("a", "queued")]);
    const events = detectTransitions(prev, [agent("a", "failed")]);
    expect(events.map((e) => e.status)).toEqual(["failed"]);
  });

  it("does not re-emit an agent that was already terminal", () => {
    const prev = snapshotStatuses([agent("a", "done")]);
    expect(detectTransitions(prev, [agent("a", "done")])).toEqual([]);
  });

  it("ignores non-terminal transitions", () => {
    const prev = snapshotStatuses([agent("a", "queued")]);
    expect(detectTransitions(prev, [agent("a", "working")])).toEqual([]);
  });

  it("skips an agent first seen already terminal (not in prev)", () => {
    const prev = snapshotStatuses([agent("a", "working")]);
    // "b" appears for the first time already done — no observed transition.
    const events = detectTransitions(prev, [agent("a", "working"), agent("b", "done")]);
    expect(events).toEqual([]);
  });
});
