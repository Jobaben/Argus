import { useEffect, useState } from "react";
import { subscribeLive } from "./live/liveSocket";

export interface LiveActivity {
  label: string;
  at: string;
}

interface RunActivityMessage {
  type?: string;
  runId?: string;
  events?: { at: string; kind: string; label: string }[];
}

/**
 * Latest live-activity per runId, fed by the server's throttled
 * "run:activity" WS batches. Entries are only read for steps the overview
 * still reports as running, so stale keys are harmless and the map is simply
 * dropped on unmount.
 */
export function useRunActivity(): Map<string, LiveActivity> {
  const [activity, setActivity] = useState<Map<string, LiveActivity>>(() => new Map());
  useEffect(
    () =>
      subscribeLive({
        onMessage: (msg) => {
          const m = msg as RunActivityMessage;
          if (m.type !== "run:activity" || !m.runId || !m.events?.length) return;
          const last = m.events[m.events.length - 1];
          setActivity((prev) => {
            const next = new Map(prev);
            next.set(m.runId!, { label: last.label, at: last.at });
            return next;
          });
        },
      }),
    [],
  );
  return activity;
}
