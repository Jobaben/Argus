/**
 * Subsequence fuzzy matching with position feedback.
 *
 * The palette has to feel like it read your mind from three keystrokes, which
 * rules out substring search ("dpa" should find "Dependency audit") and rules
 * out an opaque score (the matched characters have to be highlightable, or the
 * user can't tell *why* a result ranked where it did).
 *
 * So: match the query as a subsequence of the target, and rank by *where* the
 * matches landed rather than just whether they exist. The bonuses encode how
 * people actually abbreviate — initials of words ("rt" → "Release train"),
 * runs of adjacent letters, and a preference for early matches.
 */

export interface FuzzyMatch {
  /** Higher is better. Only comparable between matches on the same query. */
  score: number;
  /** Indices in the target that the query matched, ascending — for highlighting. */
  positions: number[];
}

const BONUS_CONSECUTIVE = 8;
const BONUS_WORD_START = 10;
const BONUS_CAMEL_START = 6;
const BONUS_EXACT_CASE = 1;
const PENALTY_LEADING = 2; // per skipped character before the first match
const PENALTY_MAX_LEADING = 12;
const PENALTY_GAP = 1; // per skipped character inside the match

function isWordBoundary(prev: string | undefined): boolean {
  return prev === undefined || prev === " " || prev === "-" || prev === "_" || prev === "/";
}

function isCamelStart(prev: string | undefined, ch: string): boolean {
  return prev !== undefined && prev === prev.toLowerCase() && ch !== ch.toLowerCase();
}

/**
 * Greedy left-to-right match. Greedy is the right trade here: it is O(n) per
 * candidate over a list that is re-scored on every keystroke, and for
 * short human queries it agrees with the optimal alignment in practice.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.trim();
  if (q.length === 0) return { score: 0, positions: [] };
  if (q.length > target.length) return null;

  const lowerQ = q.toLowerCase();
  const lowerT = target.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let ti = 0;

  for (let qi = 0; qi < lowerQ.length; qi += 1) {
    const wanted = lowerQ[qi];
    if (wanted === " ") continue; // spaces only separate, they never have to match
    const found = lowerT.indexOf(wanted, ti);
    if (found === -1) return null;

    const prev = found > 0 ? target[found - 1] : undefined;
    const skipped = found - ti;

    if (positions.length === 0) {
      score -= Math.min(PENALTY_MAX_LEADING, skipped * PENALTY_LEADING);
    } else if (skipped === 0) {
      score += BONUS_CONSECUTIVE;
    } else {
      score -= skipped * PENALTY_GAP;
    }

    if (isWordBoundary(prev)) score += BONUS_WORD_START;
    else if (isCamelStart(prev, target[found])) score += BONUS_CAMEL_START;
    if (target[found] === q[qi]) score += BONUS_EXACT_CASE;

    positions.push(found);
    ti = found + 1;
  }

  // Shorter targets win ties: "Issues" should beat "Issue sweep → fix → PR"
  // for the query "issues".
  score -= Math.floor(target.length / 12);
  return { score, positions };
}

/** A highlightable split of a target against its matched positions. */
export interface Segment {
  text: string;
  match: boolean;
}

export function highlight(target: string, positions: number[]): Segment[] {
  if (positions.length === 0) return [{ text: target, match: false }];
  const hit = new Set(positions);
  const segments: Segment[] = [];
  let buffer = "";
  let bufferMatch = hit.has(0);
  for (let i = 0; i < target.length; i += 1) {
    const isMatch = hit.has(i);
    if (isMatch !== bufferMatch) {
      if (buffer) segments.push({ text: buffer, match: bufferMatch });
      buffer = "";
      bufferMatch = isMatch;
    }
    buffer += target[i];
  }
  if (buffer) segments.push({ text: buffer, match: bufferMatch });
  return segments;
}

export interface Rankable {
  /** The text the query is matched against. */
  title: string;
  /** Secondary text, matched at a discount so a subtitle can still find a row. */
  subtitle?: string;
  /** Extra search terms that never render — synonyms, ids, aliases. */
  keywords?: string[];
}

export interface Ranked<T extends Rankable> {
  item: T;
  score: number;
  /** Positions within `title` only; a subtitle/keyword hit highlights nothing. */
  positions: number[];
}

const SUBTITLE_DISCOUNT = 0.6;
const KEYWORD_DISCOUNT = 0.4;

/**
 * Ranks candidates against a query, dropping non-matches.
 *
 * Ties keep input order, which is what makes the empty query useful: the
 * palette's own curation (navigation first, then actions, then entities) shows
 * through until the user types something.
 */
export function rank<T extends Rankable>(query: string, items: T[]): Ranked<T>[] {
  const q = query.trim();
  const scored: Ranked<T>[] = [];
  for (const item of items) {
    const onTitle = fuzzyMatch(q, item.title);
    let best = onTitle ? { score: onTitle.score, positions: onTitle.positions } : null;

    if (q.length > 0 && item.subtitle) {
      const onSubtitle = fuzzyMatch(q, item.subtitle);
      if (onSubtitle) {
        const score = onSubtitle.score * SUBTITLE_DISCOUNT;
        if (!best || score > best.score) best = { score, positions: [] };
      }
    }
    if (q.length > 0 && item.keywords) {
      for (const keyword of item.keywords) {
        const onKeyword = fuzzyMatch(q, keyword);
        if (!onKeyword) continue;
        const score = onKeyword.score * KEYWORD_DISCOUNT;
        if (!best || score > best.score) best = { score, positions: [] };
      }
    }
    if (best) scored.push({ item, score: best.score, positions: best.positions });
  }
  // Stable: Array.prototype.sort is required to be stable, so equal scores
  // preserve the caller's ordering.
  return scored.sort((a, b) => b.score - a.score);
}
