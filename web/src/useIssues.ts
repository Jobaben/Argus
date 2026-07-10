import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { Issue, IssueOccurrence, IssuesSummary } from "./types";

const EMPTY: IssuesSummary = { open: 0, resolved: 0, ignored: 0 };

/** Grouped run failures plus triage actions. Refreshes on run activity
 *  ("schedules:changed") and on triage from any tab ("issues:changed"). */
export function useIssues() {
  const { data, loading, error, refresh } = useLiveResource<{
    issues: Issue[];
    summary: IssuesSummary;
  }>("/api/issues", {
    events: ["schedules:changed", "issues:changed"],
    select: (j) => {
      const body = j as { issues?: Issue[]; summary?: IssuesSummary };
      return { issues: body.issues ?? [], summary: body.summary ?? EMPTY };
    },
    initial: { issues: [], summary: EMPTY },
  });

  const triage = useCallback(
    async (fingerprint: string, action: "resolve" | "ignore" | "reopen") => {
      const res = await fetch(`/api/issues/${fingerprint}/${action}`, { method: "POST" });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(msg.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    },
    [refresh],
  );

  const loadOccurrences = useCallback(async (fingerprint: string): Promise<IssueOccurrence[]> => {
    const res = await fetch(`/api/issues/${fingerprint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { occurrences?: IssueOccurrence[] };
    return body.occurrences ?? [];
  }, []);

  return { issues: data.issues, summary: data.summary, loading, error, triage, loadOccurrences };
}
