import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBriefing } from "./useBriefing";

class FakeWS {
  onmessage: ((ev: unknown) => void) | null = null;
  close() {}
}

beforeEach(() => vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() } as Response;
}

describe("useBriefing", () => {
  it("hands back a refresh, so a failed load has a Retry that works now", async () => {
    // Without it the Briefing's error had nothing to press, and the next try
    // waited out the backoff.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as Response)
      .mockResolvedValue(okJson({ attentionCount: 2, attention: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBriefing());
    await waitFor(() => expect(result.current.error).toBe("HTTP 503"));

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.briefing?.attentionCount).toBe(2);
  });
});
