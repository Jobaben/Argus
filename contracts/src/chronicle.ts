/** Cross-source swimlane timeline. */

export type ChronicleKind = "run" | "agent" | "session";
/**
 * `stopped`: the work began and was cut short — an interrupted or cancelled
 * run, a stopped agent. `idle` is work that never ran: a skipped firing, an
 * agent with nothing to do. Both are neutral; neither is a failure.
 */
export type ChronicleStatus = "working" | "done" | "failed" | "queued" | "idle" | "stopped";

export interface ChronicleSpan {
  id: string;
  kind: ChronicleKind;
  label: string;
  status: ChronicleStatus;
  startedAt: string;
  /** Null while the work is still in flight — the client draws it to "now". */
  endedAt: string | null;
  /** Hash-route deep link into the relevant Argus view, when one exists. */
  href: string | null;
  detail: string | null;
  costUsd: number | null;
  tokens: number | null;
}

export interface ChronicleGroup {
  key: string;
  label: string;
  kind: ChronicleKind;
  /** Spans packed into rows such that spans within a row never overlap. */
  rows: ChronicleSpan[][];
}

export interface Chronicle {
  windowStart: string;
  windowEnd: string;
  groups: ChronicleGroup[];
  totals: {
    spans: number;
    active: number;
    failed: number;
    costUsd: number | null;
    tokens: number | null;
  };
}
