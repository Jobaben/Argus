import { useEffect } from "react";
import { subscribeLive } from "../live/liveSocket";
import { useToastQueue } from "./useToastQueue";
import type { IncidentAlert } from "../types";

/**
 * Incident transitions, on the bell.
 *
 * The server has already decided whether an alert should ring — quiet hours are
 * a server-side policy, and a client that re-derived them would disagree with
 * the webhook the moment a clock or a timezone differed. Suppressed alerts are
 * not sent as `sentinel:alert` at all, so anything arriving here is meant to be
 * heard.
 */

const TITLES: Record<IncidentAlert["event"], string> = {
  "incident.opened": "Incident opened",
  "incident.escalated": "Incident escalated",
  "incident.acknowledged": "Incident acknowledged",
  "incident.resolved": "Incident resolved",
};

function isIncidentAlert(a: unknown): a is IncidentAlert {
  if (typeof a !== "object" || a === null) return false;
  const x = a as Partial<IncidentAlert>;
  return (
    typeof x.incidentId === "string" &&
    typeof x.title === "string" &&
    typeof x.event === "string" &&
    x.event in TITLES
  );
}

export function incidentAlertTitle(alert: IncidentAlert): string {
  return `${TITLES[alert.event]}: ${alert.title}`;
}

export function useIncidentAlerts() {
  const { toasts, push, dismiss } = useToastQueue();

  useEffect(() => {
    return subscribeLive({
      onMessage: (msg) => {
        if (msg.type !== "sentinel:alert") return;
        const alert = (msg as { alert?: unknown }).alert;
        if (!isIncidentAlert(alert)) return;
        const title = incidentAlertTitle(alert);
        push({
          key: `${alert.incidentId}:${alert.event}`,
          tone:
            alert.event === "incident.resolved"
              ? "ok"
              : alert.severity === "critical"
                ? "fail"
                : "info",
          title,
          detail: alert.detail,
          href: "#/sentinel",
        });
        // A native notification for the two transitions that mean someone has
        // to do something. Acknowledgements and resolutions are good news and
        // do not need to interrupt a different tab.
        if (
          (alert.event === "incident.opened" || alert.event === "incident.escalated") &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
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
