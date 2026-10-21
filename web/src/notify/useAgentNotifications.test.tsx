import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAgentNotifications } from "./useAgentNotifications";
import { resetNotificationLogForTest } from "./notificationLog";
import { NotificationCenter } from "./NotificationCenter";
import { ToastRegion } from "../ds/Toast";
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
  resetNotificationLogForTest();
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

  it("sets the job id in mono, on the toast and in the log both", async () => {
    // Pushed with the toast itself, so no consumer has to remember to add it.
    function Shell({ agents }: { agents: Agent[] }) {
      const { toasts, dismiss } = useAgentNotifications(agents);
      return (
        <>
          <NotificationCenter />
          <ToastRegion toasts={toasts} onDismiss={dismiss} />
        </>
      );
    }
    const user = userEvent.setup();
    const { rerender } = render(<Shell agents={[agent("job-7f3a", "working")]} />);
    rerender(<Shell agents={[agent("job-7f3a", "failed")]} />);

    const toast = await screen.findByRole("status");
    expect(within(toast).getByText("job-7f3a")).toHaveClass("font-mono");

    await user.click(screen.getByRole("button", { name: /notifications/i }));
    const log = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(log).getByText("job-7f3a")).toHaveClass("font-mono");
  });
});
