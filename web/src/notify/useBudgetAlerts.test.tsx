import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { LiveMessage } from "../live/liveSocket";

const subs = new Set<{ onMessage?: (msg: LiveMessage) => void }>();
vi.mock("../live/liveSocket", () => ({
  subscribeLive: (sub: { onMessage?: (msg: LiveMessage) => void }) => {
    subs.add(sub);
    return () => subs.delete(sub);
  },
}));

import { useBudgetAlerts } from "./useBudgetAlerts";

const emit = (msg: unknown) => {
  for (const s of subs) s.onMessage?.(msg as LiveMessage);
};

const exceededAlert = {
  event: "budget.exceeded",
  state: "exceeded",
  at: "2026-07-13T08:00:00.000Z",
  detail: "today $12.00 of $10.00 — scheduled runs are paused",
};

const native: { title: string }[] = [];
class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  constructor(title: string) {
    native.push({ title });
  }
}

beforeEach(() => {
  subs.clear();
  native.length = 0;
  MockNotification.permission = "granted";
  vi.stubGlobal("Notification", MockNotification as unknown as typeof Notification);
});
afterEach(() => vi.unstubAllGlobals());

describe("useBudgetAlerts", () => {
  it("shows a fail toast and a native notification on budget.exceeded", () => {
    const { result } = renderHook(() => useBudgetAlerts());
    act(() => emit({ type: "budget:alert", alert: exceededAlert }));
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].tone).toBe("fail");
    expect(result.current.toasts[0].title).toBe("Budget exceeded");
    expect(native).toHaveLength(1);
  });

  it("shows an ok toast on budget.cleared", () => {
    const { result } = renderHook(() => useBudgetAlerts());
    act(() =>
      emit({
        type: "budget:alert",
        alert: { ...exceededAlert, event: "budget.cleared", state: "ok" },
      }),
    );
    expect(result.current.toasts[0].tone).toBe("ok");
  });

  it("ignores unrelated frames and malformed alerts", () => {
    const { result } = renderHook(() => useBudgetAlerts());
    act(() => emit({ type: "schedules:changed" }));
    act(() => emit({ type: "budget:alert", alert: { event: "budget.exceeded" } }));
    expect(result.current.toasts).toHaveLength(0);
  });
});
