import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAutopsy } from "./useAutopsy";

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

describe("useAutopsy", () => {
  it("reads the run's postmortem on mount", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson({ autopsy: { runId: "r1" }, eligible: true, unavailable: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAutopsy("r1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/r1/autopsy", expect.anything());
    expect(result.current.eligible).toBe(true);
  });

  it("fetches nothing without a run id", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useAutopsy(null));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relaunch returns the new run's id", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve(
          path.endsWith("/relaunch")
            ? okJson({ id: "new-1" })
            : okJson({ autopsy: null, eligible: true, unavailable: null }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAutopsy("r1"));
    let created: string | null = null;
    await act(async () => {
      created = await result.current.relaunch();
    });
    expect(created).toBe("new-1");
  });

  it("regression: a rejected action surfaces the server's message instead of throwing out of the hook", async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/relaunch")
          ? ({
              ok: false,
              status: 401,
              json: async () => ({ error: "auth required" }),
              headers: new Headers(),
            } as Response)
          : okJson({ autopsy: null, eligible: true, unavailable: null }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAutopsy("r1"));
    await act(async () => {
      await result.current.relaunch();
    });
    await waitFor(() => expect(result.current.actionError).toBe("auth required"));
    expect(result.current.busy).toBe(false);
  });

  it("analyse POSTs and then refreshes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson({ autopsy: null, eligible: true, unavailable: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAutopsy("r1"));
    await act(async () => {
      await result.current.analyse();
    });
    expect(
      fetchMock.mock.calls.some(
        (c) => c[0] === "/api/runs/r1/autopsy" && (c[1] as RequestInit)?.method === "POST",
      ),
    ).toBe(true);
  });
});
