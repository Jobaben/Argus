import { useLiveResource } from "./live/useLiveResource";
import type { MonitorHealth, MonitorsSummary } from "./types";

const EMPTY: MonitorsSummary = { up: 0, late: 0, down: 0, failing: 0, paused: 0, pending: 0 };

/** Schedule health monitors. Run/schedule writes push "schedules:changed";
 *  the poll fallback keeps late→down transitions honest when nothing writes. */
export function useMonitors() {
  const { data, loading, error, refresh } = useLiveResource<{
    monitors: MonitorHealth[];
    summary: MonitorsSummary;
  }>("/api/monitors", {
    events: ["schedules:changed"],
    select: (j) => {
      const body = j as { monitors?: MonitorHealth[]; summary?: MonitorsSummary };
      return { monitors: body.monitors ?? [], summary: body.summary ?? EMPTY };
    },
    initial: { monitors: [], summary: EMPTY },
    pollAlways: true,
  });
  return { monitors: data.monitors, summary: data.summary, loading, error, refresh };
}
