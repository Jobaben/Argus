import { describe, it, expect, vi } from "vitest";
import { fireNotification, notificationTitle } from "./fireNotification";
import type { TerminalEvent } from "./detectTransitions";

const done: TerminalEvent = { short: "abc", name: "Fixer", status: "done", at: null };
const failed: TerminalEvent = { short: "xyz", name: "Builder", status: "failed", at: null };

describe("notificationTitle", () => {
  it("distinguishes finished from failed", () => {
    expect(notificationTitle(done)).toBe("Agent finished: Fixer");
    expect(notificationTitle(failed)).toBe("Agent failed: Builder");
  });
});

describe("fireNotification", () => {
  it("spawns a native notification when permission is granted", () => {
    const spawn = vi.fn();
    expect(fireNotification(done, { permission: "granted", spawn })).toBe("native");
    expect(spawn).toHaveBeenCalledWith("Agent finished: Fixer", "abc");
  });

  it("falls back to in-app when permission is denied", () => {
    const spawn = vi.fn();
    expect(fireNotification(failed, { permission: "denied", spawn })).toBe("in-app");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("falls back to in-app when not yet granted (default)", () => {
    const spawn = vi.fn();
    expect(fireNotification(done, { permission: "default", spawn })).toBe("in-app");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("falls back to in-app when the Notification API is unsupported", () => {
    const spawn = vi.fn();
    expect(fireNotification(done, { permission: "unsupported", spawn })).toBe("in-app");
    expect(spawn).not.toHaveBeenCalled();
  });
});
