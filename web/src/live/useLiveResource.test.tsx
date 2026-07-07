import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useLiveResource } from "./useLiveResource";

// A controllable fake socket the shared liveSocket singleton will instantiate.
let sockets: FakeWS[] = [];
class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor() {
    sockets.push(this);
  }
  open() {
    this.onopen?.();
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  close() {
    this.closed = true;
  }
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useLiveResource", () => {
  it("fetches once on mount and selects the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ items: [1, 2, 3] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useLiveResource("/api/things", {
        events: ["things:changed"],
        select: (j) => (j as { items: number[] }).items,
        initial: [] as number[],
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/things");
  });

  it("refetches when a matching change event arrives, ignores others", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useLiveResource("/api/things", {
        events: ["things:changed"],
        select: (j) => (j as { items: number[] }).items,
        initial: [] as number[],
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(sockets.length).toBe(1);

    await act(async () => {
      sockets[0].emit({ type: "other:changed" });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // ignored

    await act(async () => {
      sockets[0].emit({ type: "things:changed" });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); // refetched
  });

  it("reports live=true once the socket opens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ items: [] })));
    const { result } = renderHook(() =>
      useLiveResource("/api/things", {
        events: ["things:changed"],
        select: (j) => (j as { items: number[] }).items,
        initial: [] as number[],
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.live).toBe(false);
    await act(async () => {
      sockets[0].open();
    });
    await waitFor(() => expect(result.current.live).toBe(true));
  });

  it("does not fetch when path is null", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveResource(null, { select: (j) => j, initial: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
