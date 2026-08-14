/**
 * Packing the phase rail's stages into explicit rows.
 *
 * CSS wrapping breaks a flex line wherever it runs out of width, which leaves
 * the break invisible: a continued chain reads as chips floating loose under
 * the first line. The rail instead measures its stages and packs them into
 * rows itself, so each row can be a real element — a tile with a border, a
 * background, and a continuation arrow — rather than an accident of layout.
 *
 * Pure and separate from the component because packing is where the
 * off-by-ones live: a stage exactly at the limit, a stage wider than the
 * limit, and a zero-width measurement (jsdom, fonts not ready) all need a
 * defined answer.
 */

/**
 * The index of the first stage of each row.
 *
 * `limit` is the row's usable content width; `join` is the width the chain
 * costs between two stages on one row (the arrow and its gaps). A stage wider
 * than the limit still gets a row of its own — the row overflows and its
 * chips truncate, which is the best available reading. A non-positive limit
 * (unmeasured container) packs everything into one row rather than one row
 * per stage, so the pre-measurement render is the single-line rail.
 */
export function packStages(widths: number[], limit: number, join: number): number[] {
  const breaks: number[] = widths.length > 0 ? [0] : [];
  if (limit <= 0) return breaks;
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const need = i === breaks[breaks.length - 1] ? widths[i] : used + join + widths[i];
    if (need > limit && used > 0) {
      breaks.push(i);
      used = widths[i];
    } else {
      used = need;
    }
  }
  return breaks;
}

/** The rows themselves, as [start, end) index pairs over the stage list. */
export function packedRows(breaks: number[], stageCount: number): { start: number; end: number }[] {
  return breaks.map((start, i) => ({ start, end: breaks[i + 1] ?? stageCount }));
}
