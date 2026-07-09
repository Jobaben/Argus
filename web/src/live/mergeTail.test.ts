import { describe, it, expect } from "vitest";
import { mergeTail } from "./mergeTail";
import type { SessionMessage } from "../useSessions";

function msg(index: number): SessionMessage {
  return {
    index,
    type: "assistant",
    role: "assistant",
    timestamp: null,
    model: null,
    text: `m${index}`,
    toolName: null,
    isError: false,
  };
}

describe("mergeTail", () => {
  it("appends from an empty tail", () => {
    expect(mergeTail([], [msg(0), msg(1)]).map((m) => m.index)).toEqual([0, 1]);
  });

  it("appends only messages beyond the current last index", () => {
    const prev = [msg(0), msg(1)];
    expect(mergeTail(prev, [msg(2), msg(3)]).map((m) => m.index)).toEqual([0, 1, 2, 3]);
  });

  it("drops overlapping/duplicate messages", () => {
    const prev = [msg(0), msg(1)];
    // A racing refetch redelivers 1 alongside the new 2.
    expect(mergeTail(prev, [msg(1), msg(2)]).map((m) => m.index)).toEqual([0, 1, 2]);
  });

  it("returns the same reference when nothing is new", () => {
    const prev = [msg(0), msg(1)];
    expect(mergeTail(prev, [])).toBe(prev);
    expect(mergeTail(prev, [msg(0), msg(1)])).toBe(prev);
  });
});
