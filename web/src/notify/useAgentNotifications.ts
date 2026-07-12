import { useEffect, useRef } from "react";
import type { Agent } from "../types";
import { detectTransitions, snapshotStatuses, type StatusSnapshot } from "./detectTransitions";
import { fireNotification, notificationTitle } from "./fireNotification";
import { useToastQueue } from "./useToastQueue";

function currentPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * Watches the live agent list and surfaces a notification the moment an agent
 * finishes or fails — the whole point of an unattended-run monitor. Always
 * shows an in-app toast; additionally fires a native OS notification when the
 * browser has granted permission. Baseline suppression (see detectTransitions)
 * keeps a page load from replaying every already-finished agent.
 */
export function useAgentNotifications(agents: Agent[]) {
  const { toasts, push, dismiss } = useToastQueue();
  const prevRef = useRef<StatusSnapshot | null>(null);

  // Ask once, lazily, only if the browser supports notifications and the user
  // has not already decided. A denial simply leaves the in-app toast fallback.
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const events = detectTransitions(prevRef.current, agents);
    prevRef.current = snapshotStatuses(agents);
    if (events.length === 0) return;

    const permission = currentPermission();
    const spawn = (title: string, body: string) => {
      try {
        new Notification(title, { body });
      } catch {
        /* native notification unavailable; the toast remains */
      }
    };

    for (const e of events) {
      fireNotification(e, { permission, spawn });
      push({
        key: `${e.short}:${e.status}`,
        tone: e.status === "failed" ? "fail" : "ok",
        title: notificationTitle(e),
        detail: e.short,
      });
    }
  }, [agents, push]);

  return { toasts, dismiss };
}
