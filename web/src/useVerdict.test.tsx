import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useVerdict, useVerdictTrends } from "./useVerdict";

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

describe("useVerdict", () => {
  it("reads one run's score", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson({ verdict: { runId: "r1", score: 7 }, rubric: { goal: "g" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useVerdict("r1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/r1/verdict", expect.anything());
    expect(result.current.verdict?.score).toBe(7);
  });

  it("fetches nothing without a run id", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useVerdict(null));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("score POSTs and refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ verdict: null, rubric: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useVerdict("r1"));
    await act(async () => {
      await result.current.score();
    });
    expect(
      fetchMock.mock.calls.some(
        (c) => c[0] === "/api/runs/r1/verdict" && (c[1] as RequestInit)?.method === "POST",
      ),
    ).toBe(true);
  });

  it("regression: a rejected score surfaces the server's message and clears busy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_p: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === "POST"
            ? ({
                ok: false,
                status: 409,
                json: async () => ({ error: "no rubric is declared for this unit of work" }),
                headers: new Headers(),
              } as Response)
            : okJson({ verdict: null, rubric: null }),
        ),
      ),
    );
    const { result } = renderHook(() => useVerdict("r1"));
    await act(async () => {
      await result.current.score();
    });
    await waitFor(() =>
      expect(result.current.actionError).toBe("no rubric is declared for this unit of work"),
    );
    expect(result.current.busy).toBe(false);
  });
});

describe("useVerdictTrends", () => {
  it("loads the trend report", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        generatedAt: "now",
        trends: [{ key: "schedule:s1", points: [] }],
        summary: { scored: 1, regressions: 0, average: 7 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useVerdictTrends());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith("/api/verdicts", expect.anything());
    expect(result.current.report.trends).toHaveLength(1);
  });

  it("regression: a malformed body degrades to the empty report", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson("nope")));
    const { result } = renderHook(() => useVerdictTrends());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.report.trends).toEqual([]);
    expect(result.current.report.summary.average).toBeNull();
  });
});
