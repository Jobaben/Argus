import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAgentNotifications } from "./useAgentNotifications";
import type { Agent, AgentStatus } from "../types";

function agent(short: string, status: AgentStatus): Agent {
  return {
    short,
    sessionId: null,
    name: short,
    status,
    tempo: null,
    detail: null,
    result: null,
    template: null,
    cwd: null,
    cliVersion: null,
    inFlight: null,
    createdAt: null,
    updatedAt: null,
    firstTerminalAt: null,
    live: false,
    pid: null,
  };
}

const native: { title: string }[] = [];
class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  constructor(title: string) {
    native.push({ title });
  }
}

beforeEach(() => {
  native.length = 0;
  MockNotification.permission = "granted";
  vi.stubGlobal("Notification", MockNotification as unknown as typeof Notification);
});
afterEach(() => vi.unstubAllGlobals());

describe("useAgentNotifications", () => {
  it("suppresses the baseline then notifies on a later transition", async () => {
    const { result, rerender } = renderHook(({ a }) => useAgentNotifications(a), {
      initialProps: { a: [agent("x", "working")] },
    });
    // Baseline: nothing fires for an already-present working agent.
    expect(result.current.toasts).toHaveLength(0);

    rerender({ a: [agent("x", "done")] });
    await waitFor(() => expect(result.current.toasts).toHaveLength(1));
    expect(result.current.toasts[0].tone).toBe("ok");
    // Permission granted → a native notification was also spawned.
    expect(native).toHaveLength(1);
  });

  it("still shows an in-app toast when native permission is denied", async () => {
    MockNotification.permission = "denied";
    const { result, rerender } = renderHook(({ a }) => useAgentNotifications(a), {
      initialProps: { a: [agent("x", "working")] },
    });
    rerender({ a: [agent("x", "failed")] });
    await waitFor(() => expect(result.current.toasts).toHaveLength(1));
    expect(result.current.toasts[0].tone).toBe("fail");
    expect(native).toHaveLength(0);
  });
});
