import { useEffect, useState } from "react";
import { subscribeLive } from "./live/liveSocket";

/** The newest activity line seen for a run — what the step tile shows. */
export interface LiveActivity {
  label: string;
  at: string;
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
          if (msg.type !== "run:activity" || !msg.runId || msg.events.length === 0) return;
          const last = msg.events[msg.events.length - 1];
          const runId = msg.runId;
          setActivity((prev) => new Map(prev).set(runId, { label: last.label, at: last.at }));
        },
      }),
    [],
  );
  return activity;
}
