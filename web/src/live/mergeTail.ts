import type { SessionMessage } from "../useSessions";

/**
 * Append only genuinely-new messages to an accumulating transcript tail.
 *
 * The live-tail hook fetches slices that may overlap (a refetch races an
 * append) or arrive out of order, so this filters `incoming` down to messages
 * whose index is beyond the current tail. Pure and idempotent: re-applying the
 * same slice is a no-op and returns the same array reference so React can skip
 * a re-render.
 */
export function mergeTail(prev: SessionMessage[], incoming: SessionMessage[]): SessionMessage[] {
  if (incoming.length === 0) return prev;
  const lastIndex = prev.length > 0 ? prev[prev.length - 1].index : -1;
  const fresh = incoming.filter((m) => m.index > lastIndex);
  if (fresh.length === 0) return prev;
  return [...prev, ...fresh];
}
