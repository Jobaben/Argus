import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIncidentAlerts } from "./useIncidentAlerts";
import type { IncidentAlert } from "../types";

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

const alert = (over: Partial<IncidentAlert> = {}): IncidentAlert => ({
  event: "incident.opened",
  incidentId: "i1",
  key: "monitor:s1",
  title: "Nightly triage",
  detail: "no run covered the expected slot",
  severity: "critical",
  at: "2026-07-20T12:00:00.000Z",
  suppressed: false,
  ...over,
});

function deliver(frame: unknown) {
  act(() => {
    for (const ws of sockets) ws.onopen?.();
    for (const ws of sockets) ws.onmessage?.({ data: JSON.stringify(frame) });
  });
}

describe("useIncidentAlerts", () => {
  it("toasts a critical opening in the failure tone", () => {
    const { result } = renderHook(() => useIncidentAlerts());
    deliver({ type: "sentinel:alert", alert: alert() });
    expect(result.current.toasts[0].title).toBe("Incident opened: Nightly triage");
    expect(result.current.toasts[0].tone).toBe("fail");
  });

  it("a resolution is good news, not an alarm", () => {
    const { result } = renderHook(() => useIncidentAlerts());
    deliver({ type: "sentinel:alert", alert: alert({ event: "incident.resolved" }) });
    expect(result.current.toasts[0].tone).toBe("ok");
  });

  it("a warning-severity incident is a notice", () => {
    const { result } = renderHook(() => useIncidentAlerts());
    deliver({ type: "sentinel:alert", alert: alert({ severity: "warning" }) });
    expect(result.current.toasts[0].tone).toBe("info");
  });

  it("regression: a malformed payload is dropped rather than toasted as undefined", () => {
    const { result } = renderHook(() => useIncidentAlerts());
    deliver({ type: "sentinel:alert", alert: { incidentId: 7 } });
    deliver({ type: "sentinel:alert" });
    deliver({ type: "sentinel:alert", alert: alert({ event: "incident.exploded" as never }) });
    expect(result.current.toasts).toHaveLength(0);
  });

  it("ignores frames that are not incident alerts", () => {
    const { result } = renderHook(() => useIncidentAlerts());
    deliver({ type: "schedules:changed" });
    deliver({ type: "watchtower:anomaly", anomaly: { id: "a" } });
    expect(result.current.toasts).toHaveLength(0);
  });
});
