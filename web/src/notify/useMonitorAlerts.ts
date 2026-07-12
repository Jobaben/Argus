import { useEffect } from "react";
import { subscribeLive } from "../live/liveSocket";
import { useToastQueue } from "./useToastQueue";
import type { MonitorStatus } from "../types";

/** Server-pushed monitor transition, broadcast as `monitors:alert`. */
export interface MonitorAlert {
  event: "monitor.down" | "monitor.failing" | "monitor.recovered";
  scheduleId: string;
  name: string;
  status: MonitorStatus;
  at: string;
  detail: string;
}

const TITLES: Record<MonitorAlert["event"], string> = {
  "monitor.down": "Monitor down",
  "monitor.failing": "Monitor failing",
  "monitor.recovered": "Monitor recovered",
};

export function monitorAlertTitle(alert: MonitorAlert): string {
  return `${TITLES[alert.event]}: ${alert.name}`;
}

function isMonitorAlert(a: unknown): a is MonitorAlert {
  return (
    typeof a === "object" &&
    a !== null &&
    typeof (a as MonitorAlert).name === "string" &&
    (a as MonitorAlert).event in TITLES
  );
}

/**
 * Surfaces server-side monitor alerts (a schedule's dead-man's switch going
 * down/failing, or recovering) the moment they arrive on the live socket:
 * always an in-app toast, plus a native OS notification when the browser has
 * granted permission (requested once by useAgentNotifications).
 */
export function useMonitorAlerts() {
  const { toasts, push, dismiss } = useToastQueue();

  useEffect(() => {
    return subscribeLive({
      onMessage: (msg) => {
        if (msg.type !== "monitors:alert") return;
        const alert = (msg as { alert?: unknown }).alert;
        if (!isMonitorAlert(alert)) return;
        const title = monitorAlertTitle(alert);
        push({
          key: `${alert.scheduleId}:${alert.event}`,
          tone: alert.event === "monitor.recovered" ? "ok" : "fail",
          title,
          detail: alert.detail,
        });
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification(title, { body: alert.detail });
          } catch {
            /* native notification unavailable; the toast remains */
          }
        }
      },
    });
  }, [push]);

  return { toasts, dismiss };
}
