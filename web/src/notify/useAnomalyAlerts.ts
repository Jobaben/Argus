import { useEffect } from "react";
import { subscribeLive } from "../live/liveSocket";
import { useToastQueue } from "./useToastQueue";
import type { Anomaly } from "../types";

/**
 * Surfaces Watchtower anomalies the instant the server observes them.
 *
 * An anomaly is not state you can re-fetch: the report it came from is, but
 * "this run just left its envelope" happens once. So it arrives as a payload
 * frame and lands in the same toast + bell surface as monitor and budget
 * alerts, rather than as a re-fetch ping.
 *
 * Tone follows severity rather than the mere fact of an anomaly: a warn-level
 * "1.7× median duration" is information, and painting it the same red as a
 * failed monitor is how a colour stops meaning anything.
 */

function isAnomaly(a: unknown): a is Anomaly {
  if (typeof a !== "object" || a === null) return false;
  const x = a as Partial<Anomaly>;
  return (
    typeof x.id === "string" &&
    typeof x.name === "string" &&
    typeof x.detail === "string" &&
    (x.severity === "warn" || x.severity === "critical")
  );
}

export function anomalyAlertTitle(anomaly: Anomaly): string {
  return `Anomaly: ${anomaly.name}`;
}

export function useAnomalyAlerts() {
  const { toasts, push, dismiss } = useToastQueue();

  useEffect(() => {
    return subscribeLive({
      onMessage: (msg) => {
        if (msg.type !== "watchtower:anomaly") return;
        const anomaly = (msg as { anomaly?: unknown }).anomaly;
        if (!isAnomaly(anomaly)) return;
        const title = anomalyAlertTitle(anomaly);
        push({
          // The anomaly id is already deterministic per (unit, metric, run), so
          // it doubles as the de-duplication key for the toast queue.
          key: anomaly.id,
          tone: anomaly.severity === "critical" ? "fail" : "info",
          title,
          detail: anomaly.detail,
          href: "#/watchtower",
        });
        if (
          anomaly.severity === "critical" &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          try {
            new Notification(title, { body: anomaly.detail });
          } catch {
            /* native notification unavailable; the toast remains */
          }
        }
      },
    });
  }, [push]);

  return { toasts, dismiss };
}
