import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { CLOCK_TICK_MS, useClock, useTicker } from "./clock";
import { TimeAgo } from "./TimeAgo";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-07T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useClock", () => {
  it("returns a time quantised to the tick, so the value is stable between ticks", () => {
    const { result, rerender } = renderHook(() => useClock());
    const first = result.current;
    expect(first % CLOCK_TICK_MS).toBe(0);
    act(() => {
      vi.advanceTimersByTime(CLOCK_TICK_MS - 1);
    });
    rerender();
    expect(result.current).toBe(first);
  });

  it("advances once the tick elapses", () => {
    const { result } = renderHook(() => useClock());
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(CLOCK_TICK_MS);
    });
    expect(result.current).toBe(first + CLOCK_TICK_MS);
  });

  it("shares one interval across every subscriber and clears it with the last", () => {
    const a = renderHook(() => useClock());
    const b = renderHook(() => useClock());
    // One interval regardless of how many components read the clock.
    expect(vi.getTimerCount()).toBe(1);
    a.unmount();
    expect(vi.getTimerCount()).toBe(1);
    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-reads the wall clock when it wakes up after being idle", () => {
    const first = renderHook(() => useClock());
    const before = first.result.current;
    first.unmount(); // no subscribers: the interval stops

    // Time passes with the module idle — a laptop sleeping, or a tab in the
    // background with timers throttled.
    vi.setSystemTime(new Date("2026-07-07T13:00:00.000Z"));
    const second = renderHook(() => useClock());
    expect(second.result.current).toBeGreaterThan(before);
  });
});

describe("useTicker", () => {
  it("re-reads the wall clock when it is switched on, not just at mount", () => {
    // A tile mounts queued and starts working later; an elapsed time computed
    // from the mount-time value would run negative for the first tick.
    const { result, rerender } = renderHook(({ active }) => useTicker(active), {
      initialProps: { active: false },
    });
    const mounted = result.current;
    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(result.current).toBe(mounted);
    rerender({ active: true });
    expect(result.current).toBe(mounted + 90_000);
  });

  it("advances once per interval while active", () => {
    const { result } = renderHook(() => useTicker(true));
    const start = result.current;
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current).toBe(start);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(start + 1000);
  });

  it("runs no timer while inactive", () => {
    const { result } = renderHook(() => useTicker(false));
    const start = result.current;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(start);
  });
});

describe("TimeAgo", () => {
  it("keeps a relative label current instead of freezing at first render", () => {
    render(<TimeAgo iso="2026-07-07T11:58:00.000Z" />);
    expect(screen.getByText("2m ago")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(screen.getByText("5m ago")).toBeInTheDocument();
  });

  it("renders a future instant forwards", () => {
    render(<TimeAgo iso="2026-07-07T12:30:00.000Z" />);
    expect(screen.getByText("in 30m")).toBeInTheDocument();
  });

  it("exposes the machine-readable instant and a full-precision tooltip", () => {
    render(<TimeAgo iso="2026-07-07T11:58:00.000Z" />);
    const el = screen.getByText("2m ago");
    expect(el.tagName).toBe("TIME");
    expect(el).toHaveAttribute("dateTime", "2026-07-07T11:58:00.000Z");
    expect(el).toHaveAttribute("title");
  });

  it("renders a dash for a missing timestamp", () => {
    render(<TimeAgo iso={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
