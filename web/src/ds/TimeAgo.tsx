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
  if (!iso) return <span className="font-mono text-ink-faint">—</span>;
  return (
    <time
      dateTime={iso}
      className="font-mono text-ink-faint"
      title={new Date(iso).toLocaleString()}
    >
      {formatRelativeTime(iso, now)}
    </time>
  );
}
