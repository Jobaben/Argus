import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useLiveResource, retryDelay } from "./useLiveResource";

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

function okJson(body: unknown, etag?: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "etag" && etag ? etag : null) },
    json: async () => body,
  } as unknown as Response;
}

function notModified(etag: string) {
  return {
    ok: false,
    status: 304,
    headers: { get: (h: string) => (h.toLowerCase() === "etag" ? etag : null) },
    json: async () => {
      throw new Error("a 304 has no body — the hook must not parse one");
    },
  } as unknown as Response;
}

/** The `if-none-match` header sent on the nth fetch call, if any. */
function sentValidator(fetchMock: ReturnType<typeof vi.fn>, call: number): string | undefined {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
}

const NUMS = {
  select: (j: unknown) => (j as { items: number[] }).items,
  initial: [] as number[],
  events: ["things:changed"],
};

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
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/things",
      expect.objectContaining({ cache: "no-store" }),
    );
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

describe("useLiveResource — conditional requests", () => {
  it("sends the ETag back as If-None-Match on the next fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ items: [1] }, '"tag-1"'));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveResource("/api/things", NUMS));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(sentValidator(fetchMock, 0)).toBeUndefined();

    await act(async () => {
      sockets[0].emit({ type: "things:changed" });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sentValidator(fetchMock, 1)).toBe('"tag-1"');
  });

  it("keeps the current value on a 304 without re-rendering the consumer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ items: [1, 2] }, '"tag-1"'))
      .mockResolvedValue(notModified('"tag-1"'));
    vi.stubGlobal("fetch", fetchMock);

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useLiveResource("/api/things", NUMS);
    });
    await waitFor(() => expect(result.current.data).toEqual([1, 2]));
    const dataBefore = result.current.data;
    const rendersBefore = renders;

    // Three no-op broadcasts: all revalidate, none change anything.
    for (const _ of [0, 1, 2]) {
      await act(async () => {
        sockets[0].emit({ type: "things:changed" });
      });
    }
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    // Identical array *reference*: no setState ran, so no consumer re-render.
    expect(result.current.data).toBe(dataBefore);
    expect(renders).toBe(rendersBefore);
    expect(result.current.error).toBeNull();
  });

  it("adopts the new payload and validator when the resource does change", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ items: [1] }, '"tag-1"'))
      .mockResolvedValueOnce(okJson({ items: [1, 2] }, '"tag-2"'))
      .mockResolvedValue(notModified('"tag-2"'));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveResource("/api/things", NUMS));
    await waitFor(() => expect(result.current.data).toEqual([1]));

    await act(async () => {
      sockets[0].emit({ type: "things:changed" });
    });
    await waitFor(() => expect(result.current.data).toEqual([1, 2]));

    await act(async () => {
      sockets[0].emit({ type: "things:changed" });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(sentValidator(fetchMock, 2)).toBe('"tag-2"');
  });
});

describe("useLiveResource — single-flight coalescing", () => {
  it("collapses a burst of change frames into one extra fetch", async () => {
    let release: ((r: Response) => void) | null = null;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ items: [1] }, '"tag-1"'))
      // The second fetch hangs until we release it, so the burst below lands
      // while a request is genuinely in flight.
      .mockImplementationOnce(() => new Promise<Response>((res) => (release = res)))
      .mockResolvedValue(okJson({ items: [9] }, '"tag-3"'));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLiveResource("/api/things", NUMS));
    await waitFor(() => expect(result.current.data).toEqual([1]));

    await act(async () => {
      sockets[0].emit({ type: "things:changed" });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Five more frames while #2 is unresolved — all coalesce into one re-run.
    await act(async () => {
      for (const _ of [0, 1, 2, 3, 4]) sockets[0].emit({ type: "things:changed" });
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      release?.(okJson({ items: [2] }, '"tag-2"'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    // Exactly one catch-up fetch, not five.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(result.current.data).toEqual([9]));
  });
});

describe("useLiveResource — failure handling", () => {
  it("keeps the last good value on screen and marks it stale", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ items: [1, 2] }, '"tag-1"'))
      .mockRejectedValue(new Error("NetworkError"));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveResource("/api/things", NUMS));
    await waitFor(() => expect(result.current.data).toEqual([1, 2]));

    await act(async () => {
      sockets[0].emit({ type: "things:changed" });
    });
    await waitFor(() => expect(result.current.error).toBe("NetworkError"));
    expect(result.current.data).toEqual([1, 2]); // not blanked
    expect(result.current.stale).toBe(true);
  });

  it("drops the validator after a failure so recovery cannot be pinned to a stale 304", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ items: [1] }, '"tag-1"'))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(okJson({ items: [3] }, '"tag-2"'));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveResource("/api/things", NUMS));
    await waitFor(() => expect(result.current.data).toEqual([1]));

    await act(async () => {
      sockets[0].emit({ type: "things:changed" });
    });
    await waitFor(() => expect(result.current.error).toBe("boom"));

    await act(async () => {
      sockets[0].emit({ type: "things:changed" });
    });
    await waitFor(() => expect(result.current.data).toEqual([3]));
    expect(sentValidator(fetchMock, 2)).toBeUndefined();
    expect(result.current.stale).toBe(false);
  });

  it("surfaces a non-2xx status as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({}),
      } as unknown as Response),
    );
    const { result } = renderHook(() => useLiveResource("/api/things", NUMS));
    await waitFor(() => expect(result.current.error).toBe("HTTP 503"));
    // Nothing good was ever on screen, so this is not "stale" — it is empty.
    expect(result.current.stale).toBe(false);
  });
});

describe("retryDelay", () => {
  it("doubles per attempt and stays within the jitter window", () => {
    expect(retryDelay(1, () => 0)).toBe(500);
    expect(retryDelay(1, () => 1)).toBe(1000);
    expect(retryDelay(2, () => 0)).toBe(1000);
    expect(retryDelay(3, () => 1)).toBe(4000);
  });

  it("caps the ceiling so a long outage does not back off forever", () => {
    expect(retryDelay(50, () => 1)).toBe(30_000);
    expect(retryDelay(50, () => 0)).toBe(15_000);
  });

  it("de-synchronises two views that failed at the same instant", () => {
    const a = retryDelay(4, () => 0.1);
    const b = retryDelay(4, () => 0.9);
    expect(a).not.toBe(b);
  });
});
