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
});
