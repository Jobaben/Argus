import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSentinel } from "./useSentinel";

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

const STATE = {
  generatedAt: "now",
  policy: {
    enabled: true,
    levels: [{ afterMinutes: 0, label: "Notify" }],
    quietHours: null,
    quietHoursOverrideCritical: true,
    autoDiagnose: false,
  },
  incidents: [{ id: "i1" }],
  summary: { open: 1, acknowledged: 0, resolved: 0, critical: 1 },
  inQuietHours: false,
};

describe("useSentinel", () => {
  it("loads incidents and the policy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(STATE));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSentinel());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith("/api/sentinel", expect.anything());
    expect(result.current.state.incidents).toHaveLength(1);
  });

  it("acknowledging POSTs to the incident's action route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(STATE));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSentinel());
    await act(async () => {
      await result.current.act("i1", "ack");
    });
    expect(
      fetchMock.mock.calls.some(
        (c) => c[0] === "/api/incidents/i1/ack" && (c[1] as RequestInit)?.method === "POST",
      ),
    ).toBe(true);
  });

  it("a note is sent as a JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(STATE));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSentinel());
    await act(async () => {
      await result.current.act("i1", "note", { note: "looked at it" });
    });
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/incidents/i1/note");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ note: "looked at it" });
  });

  it("the policy is saved with PUT", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(STATE));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSentinel());
    await act(async () => {
      await result.current.savePolicy({ autoDiagnose: true });
    });
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/sentinel/policy");
    expect((call![1] as RequestInit).method).toBe("PUT");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ autoDiagnose: true });
  });

  it("regression: a rejected action surfaces the server's message and clears the busy flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((path: string) =>
        Promise.resolve(
          path.startsWith("/api/incidents")
            ? ({
                ok: false,
                status: 401,
                json: async () => ({ error: "auth required" }),
                headers: new Headers(),
              } as Response)
            : okJson(STATE),
        ),
      ),
    );
    const { result } = renderHook(() => useSentinel());
    await act(async () => {
      await result.current.act("i1", "ack");
    });
    await waitFor(() => expect(result.current.actionError).toBe("auth required"));
    expect(result.current.busyId).toBeNull();
  });

  it("a rejected policy save surfaces its message too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((path: string) =>
        Promise.resolve(
          path === "/api/sentinel/policy"
            ? ({
                ok: false,
                status: 400,
                json: async () => ({ error: 'quietHours.start must be "HH:MM"' }),
                headers: new Headers(),
              } as Response)
            : okJson(STATE),
        ),
      ),
    );
    const { result } = renderHook(() => useSentinel());
    await act(async () => {
      await result.current.savePolicy({ quietHours: { start: "nope", end: "07:00" } });
    });
    await waitFor(() => expect(result.current.actionError).toMatch(/HH:MM/));
  });

  it("regression: a malformed body degrades to the empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson("nope")));
    const { result } = renderHook(() => useSentinel());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state.incidents).toEqual([]);
  });
});
