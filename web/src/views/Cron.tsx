import { useCron } from "../useCron";
import type { CronDiskHint } from "../useCron";
import { AlertStrip, EmptyState } from "../ds";

function HintRow({ hint }: { hint: CronDiskHint }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2">
      <span className="mt-0.5 font-mono text-xs text-ink-dim">{hint.path}</span>
      <span className="text-xs text-ink-faint">{hint.note}</span>
    </li>
  );
}

export function CronPanel() {
  const { cron, loading, error } = useCron();

  return (
    <>
      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't reach the Argus server: ${error}`} />
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading…</p>
      ) : !cron ? (
        <EmptyState>No cron status available.</EmptyState>
      ) : (
        <div className="space-y-6">
          <section className="rounded-xl border border-run/25 bg-run/[0.06] p-5">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-run/15 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-run ring-1 ring-run/30">
                not watchable
              </span>
              <h2 className="text-base font-semibold text-ink">
                Cron routines aren't on disk
              </h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-dim">{cron.reason}</p>
          </section>

          <section className="rounded-xl border border-queue/20 bg-queue/[0.05] p-5">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-queue/15 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-queue ring-1 ring-queue/30">
                path forward
              </span>
              <h2 className="text-base font-semibold text-ink">
                How a polling host could surface them
              </h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-dim">{cron.howTo}</p>
          </section>

          <section className="rounded-xl border border-line bg-surface p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">
              On-disk scan
            </h2>
            {cron.diskHints.length === 0 ? (
              <p className="mt-3 text-sm text-ink-dim">
                Scanned the Claude home for any schedule-named store — nothing
                found, as expected. There is no file to watch.
              </p>
            ) : (
              <>
                <p className="mt-3 text-sm text-ink-dim">
                  Found {cron.diskHints.length} name-matched{" "}
                  {cron.diskHints.length === 1 ? "entry" : "entries"}. These are
                  hints only and are almost certainly unrelated to actual cron
                  routines:
                </p>
                <ul className="mt-3 space-y-2">
                  {cron.diskHints.map((h) => (
                    <HintRow key={h.path} hint={h} />
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
