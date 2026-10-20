import { useClock } from "./clock";
import { formatRelativeTime } from "./format";

/**
 * A relative timestamp, in whichever direction the instant actually lies, kept
 * current by the shared clock.
 *
 * It renders both "last run" (past) and "next expected" (future), so the
 * formatter handles both — this component used to assume the past and printed a
 * monitor's upcoming slot as `-7138s ago`. It also used to compute the label
 * once at render and never revisit it, so a quiet dashboard kept claiming its
 * data was "3m ago" long after it wasn't.
 *
 * The absolute instant stays available as a `title`, and the machine-readable
 * form on the `<time>` element, so a relative label never costs precision.
 */
export function TimeAgo({ iso }: { iso: string | null | undefined }) {
  const now = useClock();
  // The brand face with tabular figures, not the system monospace: these sit
  // inside sentences ("ran 3m ago"), and a monospace "3m  ago" mid-sentence
  // reads as a rendering fault.
  if (!iso) return <span className="text-ink-faint">—</span>;
  return (
    <time
      dateTime={iso}
      className="whitespace-nowrap text-ink-faint"
      title={new Date(iso).toLocaleString()}
    >
      {formatRelativeTime(iso, now)}
    </time>
  );
}
