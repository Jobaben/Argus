import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAnomalyAlerts } from "./useAnomalyAlerts";
import type { Anomaly } from "../types";

let sockets: FakeWS[] = [];

class FakeWS {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor() {
    sockets.push(this);
  }
  close() {}
  send() {}
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const anomaly = (over: Partial<Anomaly> = {}): Anomaly => ({
  id: "schedule:s1|cost|r9",
  key: "schedule:s1",
  scope: "schedule",
  name: "Nightly triage",
  runId: "r9",
  scheduleId: "s1",
  metric: "cost",
  direction: "high",
  severity: "critical",
  value: 0.42,
  median: 0.1,
  ratio: 4.2,
  zScore: 21.6,
  at: "2026-07-20T11:00:00.000Z",
  detail: "4.2× median cost",
  ...over,
});

function deliver(frame: unknown) {
  act(() => {
    for (const ws of sockets) ws.onopen?.();
    for (const ws of sockets) ws.onmessage?.({ data: JSON.stringify(frame) });
  });
}

describe("useAnomalyAlerts", () => {
  it("toasts a critical anomaly in the failure tone", () => {
    const { result } = renderHook(() => useAnomalyAlerts());
    deliver({ type: "watchtower:anomaly", anomaly: anomaly() });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].title).toBe("Anomaly: Nightly triage");
    expect(result.current.toasts[0].tone).toBe("fail");
  });

  it("a warn-level anomaly is a notice, not an alarm", () => {
    const { result } = renderHook(() => useAnomalyAlerts());
    deliver({ type: "watchtower:anomaly", anomaly: anomaly({ severity: "warn" }) });
    expect(result.current.toasts[0].tone).toBe("info");
  });

  it("regression: a malformed payload is dropped rather than toasted as undefined", () => {
    const { result } = renderHook(() => useAnomalyAlerts());
    deliver({ type: "watchtower:anomaly", anomaly: { id: 7 } });
    deliver({ type: "watchtower:anomaly" });
    deliver({ type: "watchtower:anomaly", anomaly: anomaly({ severity: "unknown" as never }) });
    expect(result.current.toasts).toHaveLength(0);
  });

  it("ignores frames that are not anomalies", () => {
    const { result } = renderHook(() => useAnomalyAlerts());
    deliver({ type: "schedules:changed" });
    deliver({ type: "monitors:alert", alert: { event: "monitor.down", name: "x" } });
    expect(result.current.toasts).toHaveLength(0);
  });
});
