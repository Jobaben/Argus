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

import { useMonitorAlerts } from "./useMonitorAlerts";

const emit = (msg: unknown) => {
  for (const s of subs) s.onMessage?.(msg as LiveMessage);
};

const downAlert = {
  event: "monitor.down",
  scheduleId: "s1",
  name: "Nightly audit",
  status: "down",
  at: "2026-07-12T08:00:00.000Z",
  detail: "no run covered the slot expected at 2026-07-12T02:00:00.000Z",
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

describe("useMonitorAlerts", () => {
  it("shows a fail toast and a native notification on monitor.down", () => {
    const { result } = renderHook(() => useMonitorAlerts());
    act(() => emit({ type: "monitors:alert", alert: downAlert }));
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].tone).toBe("fail");
    expect(result.current.toasts[0].title).toMatch(/Monitor down: Nightly audit/);
    expect(native).toHaveLength(1);
  });

  it("shows an ok toast on monitor.recovered", () => {
    const { result } = renderHook(() => useMonitorAlerts());
    act(() =>
      emit({
        type: "monitors:alert",
        alert: { ...downAlert, event: "monitor.recovered", status: "up" },
      }),
    );
    expect(result.current.toasts[0].tone).toBe("ok");
  });

  it("stays quiet without native permission but still toasts", () => {
    MockNotification.permission = "denied";
    const { result } = renderHook(() => useMonitorAlerts());
    act(() => emit({ type: "monitors:alert", alert: downAlert }));
    expect(result.current.toasts).toHaveLength(1);
    expect(native).toHaveLength(0);
  });

  it("ignores other live messages and malformed alerts", () => {
    const { result } = renderHook(() => useMonitorAlerts());
    act(() => emit({ type: "schedules:changed" }));
    act(() => emit({ type: "monitors:alert" }));
    expect(result.current.toasts).toHaveLength(0);
  });
});
