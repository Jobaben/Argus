import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "../types";
import { detectTransitions, snapshotStatuses, type StatusSnapshot } from "./detectTransitions";
import { fireNotification, notificationTitle } from "./fireNotification";
import type { ToastItem } from "../ds/Toast";

const TOAST_TTL_MS = 8000;
const MAX_TOASTS = 4;

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
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const prevRef = useRef<StatusSnapshot | null>(null);
  const seqRef = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

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

    const fresh: ToastItem[] = events.map((e) => {
      fireNotification(e, { permission, spawn });
      return {
        id: `${e.short}:${e.status}:${seqRef.current++}`,
        tone: e.status === "failed" ? "fail" : "ok",
        title: notificationTitle(e),
        detail: e.short,
      };
    });

    setToasts((ts) => [...ts, ...fresh].slice(-MAX_TOASTS));
    for (const t of fresh) {
      timers.current.set(
        t.id,
        setTimeout(() => dismiss(t.id), TOAST_TTL_MS),
      );
    }
  }, [agents, dismiss]);

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  return { toasts, dismiss };
}
