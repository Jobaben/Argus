import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFleet } from "./useFleet";

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

const FLEET = { soloMode: false, machines: [{ isSelf: true }], generatedAt: "x" };

describe("useFleet", () => {
  it("reads the fleet, keeping the empty shape's fields when the server omits them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson(FLEET)));
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fleet.soloMode).toBe(false);
    // A partial payload must not leave the page reading `undefined.machines`.
    expect(result.current.fleet.totals.machines).toBe(0);
  });

  it("a non-object body falls back to solo rather than crashing the page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson("nope")));
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fleet.soloMode).toBe(true);
  });

  it("minting a secret holds it in memory and can drop it again", async () => {
    const fetchMock = vi.fn((path: string) =>
      Promise.resolve(
        okJson(path === "/api/peers/pair" ? { secret: "f".repeat(64), instructions: "…" } : FLEET),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useFleet());
    await act(async () => {
      await result.current.mintPairing();
    });
    expect(result.current.pairing?.secret).toBe("f".repeat(64));
    act(() => result.current.clearPairing());
    expect(result.current.pairing).toBeNull();
  });

  it("adding a peer POSTs it and refreshes the view", async () => {
    const fetchMock = vi.fn((_p: string, _init?: RequestInit) => Promise.resolve(okJson(FLEET)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useFleet());
    await act(async () => {
      await result.current.addPeer({ label: "Box", url: "http://box", secret: "a".repeat(64) });
    });
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/peers")!;
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(result.current.actionError).toBeNull();
  });

  it("unpairing DELETEs the peer by id, url-encoded", async () => {
    const fetchMock = vi.fn((_p: string, _init?: RequestInit) => Promise.resolve(okJson(FLEET)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useFleet());
    await act(async () => {
      await result.current.unpair("p 1");
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith("/api/peers/p"))!;
    expect(call[0]).toBe("/api/peers/p%201");
    expect((call[1] as RequestInit).method).toBe("DELETE");
  });

  it("renaming PUTs the label", async () => {
    const fetchMock = vi.fn((_p: string, _init?: RequestInit) => Promise.resolve(okJson(FLEET)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useFleet());
    await act(async () => {
      await result.current.rename("Studio");
    });
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/fleet/label")!;
    expect((call[1] as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ label: "Studio" });
  });

  it("regression: a rejected pairing surfaces the server's reason, not a status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/peers"
            ? ({
                ok: false,
                status: 400,
                json: async () => ({ error: "that machine is already paired" }),
              } as Response)
            : okJson(FLEET),
        ),
      ),
    );
    const { result } = renderHook(() => useFleet());
    await act(async () => {
      await result.current.addPeer({ label: "Box", url: "http://box", secret: "a".repeat(64) });
    });
    expect(result.current.actionError).toBe("that machine is already paired");
    expect(result.current.busy).toBe(false);
  });

  it("a 401 says to sign in rather than reporting a bare HTTP code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/peers/pair"
            ? ({ ok: false, status: 401, json: async () => ({}) } as Response)
            : okJson(FLEET),
        ),
      ),
    );
    const { result } = renderHook(() => useFleet());
    await act(async () => {
      await result.current.mintPairing();
    });
    expect(result.current.actionError).toBe("sign in to change pairings");
  });
});
