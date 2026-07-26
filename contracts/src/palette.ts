/**
 * The command palette's search index.
 *
 * The palette needs one flat, ranked-on-the-client list of everything a user
 * might jump to: pipelines, schedules, monitors, issues, background agents,
 * projects, recent transcripts. Assembling that in the browser would mean seven
 * parallel requests on every open, each pulling a full view payload to keep
 * three fields — and then re-deriving the labels each view already computes.
 *
 * So the server serves the index instead: one request, one small payload, every
 * label and deep link already resolved. It is a *derivation*, nothing is
 * persisted for it, and it is deliberately lossy — enough to find a thing and
 * go to it, never enough to render a view from.
 */

export type PaletteKind =
  "pipeline" | "schedule" | "monitor" | "issue" | "agent" | "project" | "session";

/**
 * How much the entry wants attention. Presentation-neutral on purpose: the
 * server knows a monitor is down and an issue is open, the client decides what
 * red means.
 */
export type PaletteSeverity = "none" | "info" | "warn" | "error";

export interface PaletteEntry {
  kind: PaletteKind;
  /** Unique within `kind`. */
  id: string;
  title: string;
  /** One line of context — a trigger summary, a project, a failure count. */
  subtitle: string | null;
  /** Hash route to open the entry. */
  href: string;
  /** Short status word for the row, when the entity has one ("failing", "3 open"). */
  badge: string | null;
  severity: PaletteSeverity;
  /** Searchable but never rendered: ids, encoded project names, aliases. */
  keywords?: string[];
  /**
   * Set on a pipeline whose current phase is waiting for a human, so the palette
   * can offer the approval directly instead of making the user find the board.
   */
  gateInstanceId?: string;
  /** Set on a schedule that can be fired now. */
  runnableScheduleId?: string;
}

export interface PaletteIndex {
  generatedAt: string;
  entries: PaletteEntry[];
}
