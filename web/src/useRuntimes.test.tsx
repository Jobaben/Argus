import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { runtimeLabel } from "./useRuntimes";

const CAPS = {
  presetSessionId: true,
  appendSystemPrompt: true,
  reportsCost: true,
  reportsTokens: true,
  signalHook: true,
  liveActivity: true,
  transcripts: true,
};

/** A fresh module per test: the hook shares one in-flight promise by design,
 *  so each case needs its own instance to observe the caching honestly. */
async function freshHook() {
  vi.resetModules();
  return import("./useRuntimes");
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useRuntimes", () => {
  it("assumes Claude Code while the roster is in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise(() => {
            /* never settles */
          }),
      ),
    );
    const { useRuntimes } = await freshHook();
    const { result } = renderHook(() => useRuntimes());
    // The same assumption the server makes when nothing names a runtime.
    expect(result.current.default).toBe("claude");
    expect(result.current.runtimes).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it("reports the roster once it arrives", async () => {
    const body = {
      default: "codex",
      runtimes: [
        {
          id: "codex",
          label: "Codex",
          bin: "codex",
          home: "/h/.codex",
          available: true,
          isDefault: true,
          models: [],
          capabilities: CAPS,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(body) })),
    );
    const { useRuntimes } = await freshHook();
    const { result } = renderHook(() => useRuntimes());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.default).toBe("codex");
    expect(result.current.runtimes).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("fetches once however many pickers ask", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ default: "claude", runtimes: [] }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { useRuntimes } = await freshHook();
    const a = renderHook(() => useRuntimes());
    const b = renderHook(() => useRuntimes());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty roster rather than throwing inside a render", async () => {
    // An older server, or a stubbed fetch, can answer without the array.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
    );
    const { useRuntimes } = await freshHook();
    const { result } = renderHook(() => useRuntimes());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.runtimes).toEqual([]);
    expect(result.current.default).toBe("claude");
  });

  it("surfaces a failure and does not cache it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ default: "claude", runtimes: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const { useRuntimes } = await freshHook();
    const first = renderHook(() => useRuntimes());
    await waitFor(() => expect(first.result.current.error).toBe("HTTP 503"));
    // A later mount gets another go rather than being stuck with the failure.
    const second = renderHook(() => useRuntimes());
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("runtimeLabel", () => {
  it("names the runtimes, and nothing for an absent one", () => {
    expect(runtimeLabel("claude")).toBe("Claude Code");
    expect(runtimeLabel("codex")).toBe("Codex");
    expect(runtimeLabel(null)).toBe("");
    expect(runtimeLabel(undefined)).toBe("");
  });
});
