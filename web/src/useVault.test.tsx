import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useVaultQuarters, useVaultSearch, useVaultStatus } from "./useVault";

class FakeWS {
  onmessage: ((ev: unknown) => void) | null = null;
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() } as Response;
}

describe("useVaultStatus", () => {
  it("reads the status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ available: true, rows: {} })));
    const { result } = renderHook(() => useVaultStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.available).toBe(true);
  });

  it("a non-object body falls back to the empty status rather than crashing a panel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson("nope")));
    const { result } = renderHook(() => useVaultStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.rows.runs).toBe(0);
  });
});

describe("useVaultQuarters", () => {
  it("reads the report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okJson({ available: true, detail: "", quarters: [{ key: "x" }] })),
    );
    const { result } = renderHook(() => useVaultQuarters());
    await waitFor(() => expect(result.current.data.quarters).toHaveLength(1));
  });

  it("a non-object body falls back to an empty report", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson(7)));
    const { result } = renderHook(() => useVaultQuarters());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.quarters).toEqual([]);
  });
});

describe("useVaultSearch", () => {
  it("asks nothing for a query under two characters", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useVaultSearch("a"));
    vi.advanceTimersByTime(1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("debounces, then returns the hits", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson({ available: true, hits: [{ ref: "r1" }], relatedTerms: ["x"] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useVaultSearch("widget"));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    await waitFor(() => expect(result.current.response.hits).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/vault/search?q=widget", expect.anything());
    expect(result.current.loading).toBe(false);
  });

  it("clears the previous answer when the query is emptied", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ available: true, hits: [{}] })));
    const { result, rerender } = renderHook(({ q }) => useVaultSearch(q), {
      initialProps: { q: "widget" },
    });
    vi.advanceTimersByTime(400);
    await waitFor(() => expect(result.current.response.hits).toHaveLength(1));
    rerender({ q: "" });
    // A stale result under an empty box reads as "these still match", which is
    // exactly what it no longer means.
    expect(result.current.response.hits).toEqual([]);
  });

  it("regression: a slow first response cannot overwrite a newer one", async () => {
    let resolveFirst: ((r: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue(okJson({ available: true, hits: [{ ref: "second" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(({ q }) => useVaultSearch(q), {
      initialProps: { q: "first" },
    });
    vi.advanceTimersByTime(400);
    rerender({ q: "second" });
    vi.advanceTimersByTime(400);
    await waitFor(() => expect(result.current.response.hits[0]?.ref).toBe("second"));

    resolveFirst?.(okJson({ available: true, hits: [{ ref: "first" }] }));
    await Promise.resolve();
    expect(result.current.response.hits[0]?.ref).toBe("second");
  });

  it("a failed search reports the error and keeps the box usable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response),
    );
    const { result } = renderHook(() => useVaultSearch("widget"));
    vi.advanceTimersByTime(400);
    await waitFor(() => expect(result.current.error).toBe("HTTP 500"));
    expect(result.current.loading).toBe(false);
  });
});
