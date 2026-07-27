import type { SessionSummary } from "../useSessions";
import { fuzzyMatch } from "../cmd/fuzzy";

/**
 * Filtering and day-grouping for the Sessions list.
 *
 * The list was a flat grid ordered by recency, which works for the first screen
 * and stops working at fifty transcripts: "the one from this morning where I
 * broke the migration" is answerable only by scrolling and guessing. Days are
 * how people remember sessions, and the same fuzzy matcher the palette uses does
 * the searching so "arg mig" behaves identically in both places.
 */

export interface SessionGroup {
  /** Stable React key: a local calendar date, or "undated". */
  key: string;
  label: string;
  sessions: SessionSummary[];
}

/** Local calendar date of an instant, as `YYYY-MM-DD`. Local, not UTC: the
 *  reader's "yesterday" is their own midnight, not Greenwich's. */
export function localDayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayLabel(key: string, now: Date): string {
  const today = localDayKey(now);
  if (key === today) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localDayKey(yesterday)) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  const at = new Date(y, m - 1, d);
  // Within the last week the weekday is the most recognisable handle; beyond it,
  // a weekday alone is ambiguous, so the date takes over.
  const days = Math.round((now.getTime() - at.getTime()) / 86_400_000);
  return days < 7
    ? at.toLocaleDateString(undefined, { weekday: "long" })
    : at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function activityAt(session: SessionSummary): number | null {
  const iso = session.lastActivity ?? session.firstActivity;
  if (!iso) return null;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? null : at;
}

/**
 * Newest day first, newest session first within a day; anything with no usable
 * timestamp lands in a trailing "Undated" group rather than being dropped — a
 * transcript we can't date is still a transcript the user may be looking for.
 */
export function groupSessionsByDay(
  sessions: SessionSummary[],
  now: Date = new Date(),
): SessionGroup[] {
  const byDay = new Map<string, { at: number; sessions: SessionSummary[] }>();
  const undated: SessionSummary[] = [];

  for (const session of sessions) {
    const at = activityAt(session);
    if (at === null) {
      undated.push(session);
      continue;
    }
    const key = localDayKey(new Date(at));
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.sessions.push(session);
      bucket.at = Math.max(bucket.at, at);
    } else {
      byDay.set(key, { at, sessions: [session] });
    }
  }

  const groups = [...byDay.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .map(([key, bucket]) => ({
      key,
      label: dayLabel(key, now),
      sessions: bucket.sessions.sort((a, b) => (activityAt(b) ?? 0) - (activityAt(a) ?? 0)),
    }));

  if (undated.length > 0) groups.push({ key: "undated", label: "Undated", sessions: undated });
  return groups;
}

/**
 * Fuzzy filter over the fields a person would actually type: what the session
 * was about, which project it ran in, and which model ran it.
 *
 * Each field is scored separately and the best wins, so a query that matches a
 * title strongly is not diluted by the long project path it also has to
 * subsequence-match against.
 */
export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const q = query.trim();
  if (!q) return sessions;
  const scored: { session: SessionSummary; score: number }[] = [];
  for (const session of sessions) {
    let best = -Infinity;
    for (const field of [session.title, session.projectLabel, session.model ?? ""]) {
      const match = field ? fuzzyMatch(q, field) : null;
      if (match && match.score > best) best = match.score;
    }
    if (best > -Infinity) scored.push({ session, score: best });
  }
  // Score first, then recency: two equally good matches should come back with the
  // fresher one on top, and a stable sort alone would not guarantee that.
  scored.sort(
    (a, b) => b.score - a.score || (activityAt(b.session) ?? 0) - (activityAt(a.session) ?? 0),
  );
  return scored.map((s) => s.session);
}
