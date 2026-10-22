import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useOverview } from "./useOverview";

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

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe("useOverview gate actions", () => {
  it("sends the phase to approve, and carries a refusal's code with its words", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ overview: [] })) // mount refresh
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          error: "c-b is a spawned child and its parent moved on",
          code: "parent-decided",
        }),
      } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useOverview());
    const refused = await result.current.approve("c-b", { phaseId: "pr" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe("c-b is a spawned child and its parent moved on");
    expect((refused as { code?: string }).code).toBe("parent-decided");
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/instances/c-b/approve");
    expect(init.body).toBe(JSON.stringify({ phaseId: "pr" }));
  });

  it("says the status when a refusal has no words, and no code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ overview: [] }))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not JSON");
        },
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useOverview());
    const refused = await result.current.abort("p-1").catch((e: unknown) => e);
    expect((refused as Error).message).toBe("HTTP 500");
    expect((refused as { code?: string }).code).toBeUndefined();
  });
});
