import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useRecording } from "./useRecording";

class FakeWS {
  onmessage: ((ev: unknown) => void) | null = null;
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() } as Response;
}

describe("useRecording", () => {
  it("fetches the run's recording and encodes the id into the path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ runId: "a/b", events: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useRecording("a/b"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/a%2Fb/recording", expect.anything());
    expect(result.current.recording?.runId).toBe("a/b");
  });

  it("fetches nothing without a run id", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useRecording(null));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.recording).toBeNull();
  });

  it("regression: a non-object body yields null rather than a broken recording", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson("not a recording")));
    const { result } = renderHook(() => useRecording("r1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recording).toBeNull();
  });
});
