import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useLedger } from "./useLedger";

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

describe("useLedger", () => {
  it("reads the report and keeps the empty shape's fields when the server omits them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ windowDays: 7 })));
    const { result } = renderHook(() => useLedger());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.report.windowDays).toBe(7);
    // A partial payload must not leave the panels reading `undefined.slices`.
    expect(result.current.report.bySchedule.slices).toEqual([]);
    expect(result.current.report.enforcement.action).toBeNull();
  });

  it("falls back to the empty report when the body is not an object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson(null)));
    const { result } = renderHook(() => useLedger());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.report.windowDays).toBe(30);
  });

  it("a simulation POSTs the request and holds the result", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve(
          path === "/api/ledger/what-if"
            ? okJson({ ok: true, summary: "haiku saves $4.00/mo", unavailable: null })
            : okJson({}),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLedger());
    await act(async () => {
      await result.current.simulate({ dimension: "schedule", key: "s1", toModel: "haiku" });
    });
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/ledger/what-if")!;
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      dimension: "schedule",
      key: "s1",
      toModel: "haiku",
    });
    expect(result.current.simulation?.summary).toBe("haiku saves $4.00/mo");
    expect(result.current.simulating).toBe(false);
    expect(result.current.simError).toBeNull();
  });

  it("regression: a rejected simulation shows the server's reason and drops the stale result", async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) =>
      Promise.resolve(
        path === "/api/ledger/what-if"
          ? ({
              ok: false,
              status: 400,
              json: async () => ({ error: "unknown dimension" }),
              headers: new Headers(),
            } as Response)
          : okJson({}),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLedger());
    await act(async () => {
      await result.current.simulate({ dimension: "schedule", key: "s1", toModel: "haiku" });
    });
    expect(result.current.simError).toBe("unknown dimension");
    // A failed second pass must not leave the first pass's answer on screen.
    expect(result.current.simulation).toBeNull();
    expect(result.current.simulating).toBe(false);
  });

  it("a thrown fetch is reported rather than swallowed", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((path: string) =>
        path === "/api/ledger/what-if"
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(okJson({})),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLedger());
    await act(async () => {
      await result.current.simulate({ dimension: "model", key: "opus", toModel: "haiku" });
    });
    expect(result.current.simError).toBe("offline");
  });
});
