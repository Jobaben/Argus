/**
 * When a palette query stops being a search and starts being an instruction.
 *
 * Three words and twelve characters, and the threshold is deliberately
 * conservative in both directions. "nightly triage" must stay a search, because
 * fuzzy-jumping is what the palette is for and a planning pass costs real
 * money; but "pause everything touching Spectacle" should be recognisable as
 * something to interpret without the user learning a prefix character.
 *
 * Crossing the threshold only *offers* intent mode. Nothing is compiled until
 * the user asks, so the fast path is never interrupted by a guess.
 */
export function looksLikeIntent(query: string): boolean {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= 3 && trimmed.length >= 12;
}
