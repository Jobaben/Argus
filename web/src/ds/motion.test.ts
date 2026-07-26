import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { staggerDelay, useChangeFlash, useCountUp } from "./motion";

/** Drives requestAnimationFrame from fake timers so counting is deterministic. */
function installRaf() {
  let now = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void callbacks.delete(id));
  vi.stubGlobal("performance", { now: () => now });
  return {
    advance(ms: number) {
      now += ms;
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, cb] of pending) cb(now);
    },
  };
}

function setReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduce && query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  setReducedMotion(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useCountUp", () => {
  it("shows the first value immediately — a page load is not an animation", () => {
    const raf = installRaf();
    const { result } = renderHook(() => useCountUp(42));
    expect(result.current).toBe(42);
    act(() => raf.advance(500));
    expect(result.current).toBe(42);
  });

  it("animates toward a new value and lands exactly on it", () => {
    const raf = installRaf();
    const { result, rerender } = renderHook(({ v }) => useCountUp(v), {
      initialProps: { v: 100 },
    });
    rerender({ v: 200 });
    act(() => raf.advance(100));
    expect(result.current).toBeGreaterThan(100);
    expect(result.current).toBeLessThan(200);
    act(() => raf.advance(1000));
    expect(result.current).toBe(200);
  });

  it("snaps instead of animating when the jump is a different order of magnitude", () => {
    const raf = installRaf();
    const { result, rerender } = renderHook(({ v }) => useCountUp(v), { initialProps: { v: 1 } });
    rerender({ v: 8_900_000 });
    // No frame has run yet; a rolling counter here would just be unreadable.
    expect(result.current).toBe(8_900_000);
    act(() => raf.advance(50));
    expect(result.current).toBe(8_900_000);
  });

  it("snaps when the user asked for reduced motion", () => {
    setReducedMotion(true);
    const raf = installRaf();
    const { result, rerender } = renderHook(({ v }) => useCountUp(v), { initialProps: { v: 10 } });
    rerender({ v: 20 });
    expect(result.current).toBe(20);
    act(() => raf.advance(16));
    expect(result.current).toBe(20);
  });

  it("snaps on non-finite input rather than looping forever", () => {
    installRaf();
    const { result, rerender } = renderHook(({ v }) => useCountUp(v), { initialProps: { v: 5 } });
    rerender({ v: Number.NaN });
    expect(Number.isNaN(result.current)).toBe(true);
  });

  it("does nothing when the value is unchanged", () => {
    const raf = installRaf();
    const { result, rerender } = renderHook(({ v }) => useCountUp(v), { initialProps: { v: 7 } });
    rerender({ v: 7 });
    act(() => raf.advance(16));
    expect(result.current).toBe(7);
  });
});

describe("useChangeFlash", () => {
  it("does not flash on the initial value", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useChangeFlash("working"));
    expect(result.current).toBe(false);
  });

  it("flashes when the key changes, then clears itself", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ k }) => useChangeFlash(k, 900), {
      initialProps: { k: "working" },
    });
    rerender({ k: "failed" });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(899));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(2));
    expect(result.current).toBe(false);
  });

  it("restarts the window on a second change instead of clearing early", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ k }) => useChangeFlash(k, 900), {
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    act(() => vi.advanceTimersByTime(800));
    rerender({ k: "c" });
    act(() => vi.advanceTimersByTime(800));
    expect(result.current).toBe(true); // the second change's window is still open
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe(false);
  });

  it("never flashes under reduced motion", () => {
    setReducedMotion(true);
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ k }) => useChangeFlash(k), {
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    expect(result.current).toBe(false);
  });
});

describe("staggerDelay", () => {
  it("steps per index", () => {
    expect(staggerDelay(0)).toBe("0ms");
    expect(staggerDelay(3, 28)).toBe("84ms");
  });

  it("caps, so a long list does not take seconds to finish arriving", () => {
    expect(staggerDelay(100, 28, 240)).toBe("240ms");
  });
});
