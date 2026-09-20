import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useRunActivity } from "./useRunActivity";

let sockets: FakeWS[] = [];
class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  open() {
    this.onopen?.();
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  close() {}
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useRunActivity", () => {
  it("tracks the latest event label per runId from run:activity batches", async () => {
    const { result, unmount } = renderHook(() => useRunActivity());
    await waitFor(() => expect(sockets.length).toBe(1));
    act(() => {
      sockets[0].open();
      sockets[0].emit({
        type: "run:activity",
        runId: "r1",
        instanceId: "i1",
        events: [
          { at: "2026-07-07T10:00:00.000Z", kind: "tool", label: "Bash: npm ci" },
          { at: "2026-07-07T10:00:05.000Z", kind: "tool", label: "Bash: npm test" },
        ],
      });
    });
    await waitFor(() =>
      expect(result.current.get("r1")).toEqual({
        label: "Bash: npm test",
        at: "2026-07-07T10:00:05.000Z",
      }),
    );
    act(() => {
      sockets[0].emit({ type: "pipelines:changed" }); // unrelated messages ignored
      sockets[0].emit({ type: "run:activity", runId: "r2" }); // missing events ignored
    });
    expect(result.current.size).toBe(1);
    unmount();
  });

  it("keeps the same map when a frame repeats the line already shown", async () => {
    // The server flushes a batch per run per second; a repeated line is a
    // heartbeat, not a change, and must not re-render the board.
    const { result, unmount } = renderHook(() => useRunActivity());
    await waitFor(() => expect(sockets.length).toBe(1));
    const frame = {
      type: "run:activity",
      runId: "r1",
      instanceId: "i1",
      events: [{ at: "2026-07-07T10:00:00.000Z", kind: "tool", label: "Bash: npm ci" }],
    };
    act(() => {
      sockets[0].open();
      sockets[0].emit(frame);
    });
    await waitFor(() => expect(result.current.get("r1")?.label).toBe("Bash: npm ci"));
    const before = result.current;
    act(() => {
      sockets[0].emit(frame);
    });
    expect(result.current).toBe(before);
    act(() => {
      sockets[0].emit({
        ...frame,
        events: [{ at: "2026-07-07T10:00:03.000Z", kind: "tool", label: "Bash: npm test" }],
      });
    });
    expect(result.current).not.toBe(before);
    expect(result.current.get("r1")?.label).toBe("Bash: npm test");
    unmount();
  });
});
