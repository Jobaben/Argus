import { useEffect } from "react";
import { subscribeLive } from "../live/liveSocket";
import { useToastQueue } from "./useToastQueue";
import type { BudgetState } from "../types";

/** Server-pushed budget transition, broadcast as `budget:alert`. */
export interface BudgetAlert {
  event: "budget.warning" | "budget.exceeded" | "budget.cleared";
  state: BudgetState;
  at: string;
  detail: string;
}

const TITLES: Record<BudgetAlert["event"], string> = {
  "budget.warning": "Budget warning",
  "budget.exceeded": "Budget exceeded",
  "budget.cleared": "Budget back under limit",
};

function isBudgetAlert(a: unknown): a is BudgetAlert {
  return (
    typeof a === "object" &&
    a !== null &&
    typeof (a as BudgetAlert).detail === "string" &&
    (a as BudgetAlert).event in TITLES
  );
}

/**
 * Surfaces budget transitions (crossing 80%, crossing the limit, dropping
 * back under) the moment they arrive on the live socket: an in-app toast,
 * plus a native OS notification when the browser has granted permission.
 */
export function useBudgetAlerts() {
  const { toasts, push, dismiss } = useToastQueue();

  useEffect(() => {
    return subscribeLive({
      onMessage: (msg) => {
        if (msg.type !== "budget:alert") return;
        const alert = (msg as { alert?: unknown }).alert;
        if (!isBudgetAlert(alert)) return;
        const title = TITLES[alert.event];
        push({
          key: `budget:${alert.event}`,
          tone: alert.event === "budget.cleared" ? "ok" : "fail",
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
