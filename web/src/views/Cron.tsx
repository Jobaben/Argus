import { useCron } from "../useCron";
import type { CronDiskHint } from "../useCron";

function HintRow({ hint }: { hint: CronDiskHint }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      <span className="mt-0.5 font-mono text-xs text-white/55">{hint.path}</span>
      <span className="text-xs text-white/40">{hint.note}</span>
    </li>
  );
}

export default function Cron() {
  const { cron, loading, error } = useCron();

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <h1 className="flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white">
          <span aria-hidden>🕑</span> Scheduled / cron
        </h1>
        <p className="mt-1 text-sm text-white/45">
          Recurring routines that fire on a schedule
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t reach the Argus server: {error}
        </div>
      )}

      {loading ? (
        <p className="text-white/40">Loading…</p>
      ) : !cron ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No cron status available.
        </div>
      ) : (
        <div className="space-y-6">
          <section className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-5">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-amber-300 ring-1 ring-amber-500/30">
                not watchable
              </span>
              <h2 className="text-base font-semibold text-white">
                Cron routines aren’t on disk
              </h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-white/70">{cron.reason}</p>
          </section>

          <section className="rounded-xl border border-sky-500/20 bg-sky-500/[0.05] p-5">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-sky-300 ring-1 ring-sky-500/30">
                path forward
              </span>
              <h2 className="text-base font-semibold text-white">
                How a polling host could surface them
              </h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-white/70">{cron.howTo}</p>
          </section>

          <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              On-disk scan
            </h2>
            {cron.diskHints.length === 0 ? (
              <p className="mt-3 text-sm text-white/55">
                Scanned the Claude home for any schedule-named store — nothing
                found, as expected. There is no file to watch.
              </p>
            ) : (
              <>
                <p className="mt-3 text-sm text-white/55">
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
    </div>
  );
}
