/** Cross-source swimlane timeline. */

export type ChronicleKind = "run" | "agent" | "session";
export type ChronicleStatus = "working" | "done" | "failed" | "queued" | "idle";

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
