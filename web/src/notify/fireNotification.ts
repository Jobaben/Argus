import type { TerminalEvent } from "./detectTransitions";

/** Where a notification ended up: a native OS notification, or the in-app toast
 *  fallback (permission denied, not yet granted, or unsupported browser). */
export type NotifyChannel = "native" | "in-app";

export interface NotifyDeps {
  /** "unsupported" when the browser has no Notification API. */
  permission: NotificationPermission | "unsupported";
  /** Spawns the native OS notification. Only called when permitted. */
  spawn: (title: string, body: string) => void;
}

export function notificationTitle(event: TerminalEvent): string {
  return event.status === "failed" ? `Agent failed: ${event.name}` : `Agent finished: ${event.name}`;
}

/**
 * Fire a native OS notification for a terminal event when the browser has
 * granted permission; otherwise report that the caller should fall back to the
 * in-app toast. The in-app toast is always shown by the hook regardless — this
 * decides only whether a *native* notification is additionally spawned.
 */
export function fireNotification(event: TerminalEvent, deps: NotifyDeps): NotifyChannel {
  if (deps.permission === "granted") {
    deps.spawn(notificationTitle(event), event.short);
    return "native";
  }
  return "in-app";
}
