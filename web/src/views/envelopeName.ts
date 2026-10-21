/**
 * A pipeline phase's envelope name, as a person reads it.
 *
 * Watchtower names a phase's envelope `${scheduleName} › ${phaseId}`, and the
 * schedule name of a phase run already ends in the phase's display name —
 * "Release Train · Implement › implement", "Issue sweep → fix → PR · Implement
 * the fix › fix". The id said the phase a second time, in machine form, and it
 * was what pushed the name into truncation on a phone. It is kept only when it
 * adds something: when the display name does not already carry its words, so
 * two phases that share a name stay told apart. Display only — the stored name
 * is the envelope's key in other places and stays as it was.
 */
export function splitEnvelopeName(name: string): { label: string; id: string | null } {
  const cut = name.lastIndexOf(" › ");
  if (cut < 0) return { label: name, id: null };
  const label = name.slice(0, cut);
  const id = name.slice(cut + 3);
  const phase = label.slice(label.lastIndexOf(" · ") + 1);
  const words = (s: string) =>
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  const said = new Set(words(phase));
  return { label, id: words(id).every((w) => said.has(w)) ? null : id };
}
