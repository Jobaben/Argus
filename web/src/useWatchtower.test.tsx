import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWatchtower } from "./useWatchtower";

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

describe("useWatchtower", () => {
  it("loads the report on mount", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        generatedAt: "now",
        baselines: [{ key: "schedule:s1" }],
        anomalies: [],
        summary: { ready: 1, warming: 0, anomalies: 0, critical: 0 },
        warmupRuns: 8,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useWatchtower());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.report.baselines).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/watchtower", expect.anything());
  });

  it("reset POSTs to the key's reset route, URL-encoded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useWatchtower());
    await act(async () => {
      await result.current.reset("phase:pipeline:p1:build");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/watchtower/phase%3Apipeline%3Ap1%3Abuild/reset", {
      method: "POST",
    });
  });

  it("restore DELETEs the same route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useWatchtower());
    await act(async () => {
      await result.current.restore("schedule:s1");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/watchtower/schedule%3As1/reset", {
      method: "DELETE",
    });
  });

  it("surfaces the server's own error message on a failed mutation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid baseline key" }),
        headers: new Headers(),
      } as Response),
    );
    const { result } = renderHook(() => useWatchtower());
    await expect(result.current.reset("bad key")).rejects.toThrow("invalid baseline key");
  });

  it("regression: a malformed body degrades to the empty report rather than crashing the view", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson("not a report")));
    const { result } = renderHook(() => useWatchtower());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.report.baselines).toEqual([]);
    expect(result.current.report.summary.ready).toBe(0);
  });
});
