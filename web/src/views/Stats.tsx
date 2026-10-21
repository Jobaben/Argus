import { Children, Fragment, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useStats, type DailyStat, type ModelStat, type PeakHour } from "../useStats";
import {
  AlertStrip,
  Button,
  ButtonLink,
  EmptyState,
  Handoff,
  Page,
  Section,
  Skeleton,
  formatUsd,
} from "../ds";
import { hasSessionData, hasTokenData } from "./statsGroups";
import { VaultPanels } from "./VaultPanels";
import { InfoTip } from "../ds/InfoTip";

function compact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

/** Dollars with thousands grouped: a lifetime total runs to four figures, and
 *  "$2140.55" has to be counted digit by digit. Grouped the way `formatUsd`
 *  writes every other dollar figure in the app — "$" first, a point for the
 *  cents — so a column never mixes "1 720,00 US$" with "$380.00". */
function usd(v: number): string {
  return v >= 1000
    ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : formatUsd(v);
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Column layouts by how many figures a strip holds, chosen so no row is left
 * with bare cells: the wide layout fits them all on one line, and where the
 * pairs on a phone (or the threes in between) leave an odd one out, it takes
 * the whole row. Whole class strings, so Tailwind can see them.
 */
const STRIP_COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3 max-sm:[&>:last-child]:col-span-2",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 lg:grid-cols-5 max-lg:[&>:last-child]:col-span-2",
  6: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6",
};

/**
 * A row of figures as one instrument: hairlines between the cells instead of a
 * bordered box around each, so a group reads as a group. The inner grid is
 * pulled out by a pixel on two sides so the outer cells' rules fall under the
 * panel's own edge. Some figures are optional, so the columns follow the count.
 */
function StatStrip({ children }: { children: ReactNode }) {
  const n = Children.toArray(children).length;
  return (
    <div className="overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
      <div className={`-mb-px -mr-px grid ${STRIP_COLS[n] ?? STRIP_COLS[6]}`}>{children}</div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 border-b border-r border-line px-4 py-3.5">
      <div className="truncate text-display font-semibold leading-none text-ink">{value}</div>
      <div className="mt-2 text-caption font-semibold text-ink-dim">{label}</div>
      {hint && <div className="mt-0.5 text-caption text-ink-faint">{hint}</div>}
    </div>
  );
}

// Numerals right-aligned so a column of them lines up on the decimal; the
// first column, the row's name, reads from the left. Cells sit at the top, so a
// name with its share bar under it shares a line with its figures.
const CELL = "whitespace-nowrap px-3 text-right first:pl-4 first:text-left last:pr-4";
const TH = `${CELL} eyebrow py-2.5 font-semibold`;
const TD = `${CELL} py-3 align-top text-small`;
const DIM = `${TD} text-ink-dim`;

/** A column a phone folds into the caption line under the model's name. */
const WIDE = "hidden sm:table-cell";

/**
 * The folded columns, on a phone, as one caption line. Each figure keeps its
 * unit and the separator after it, so the line wraps between pairs and never
 * strands a "·" at the start of a line.
 */
function Folded({ parts }: { parts: string[] }) {
  return (
    <span className="mt-1.5 block whitespace-normal text-caption text-ink-faint sm:hidden">
      {parts.map((p, i) =>
        i < parts.length - 1 ? (
          <Fragment key={i}>
            <span className="whitespace-nowrap">{p} ·</span>{" "}
          </Fragment>
        ) : (
          <span key={i} className="whitespace-nowrap">
            {p}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * Per-model usage as a table: the total is read first, the split after it.
 * On a phone the table keeps the two columns people come for — the total and
 * the cost — and folds the split into a line under the name, the way Budget's
 * attribution does, rather than scrolling the cost off the edge.
 */
function ModelTable({ models }: { models: ModelStat[] }) {
  const max = Math.max(0, ...models.map((m) => m.totalTokens));
  const anyWeb = models.some((m) => m.webSearchRequests > 0);
  const anyCost = models.some((m) => m.costUSD > 0);
  return (
    <div className="overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse sm:min-w-[40rem]">
          <caption className="sr-only">Tokens by model, largest first</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={TH}>
                Model
              </th>
              <th scope="col" className={`${TH} max-sm:w-20`}>
                Total
              </th>
              <th scope="col" className={`${TH} ${WIDE}`}>
                Input
              </th>
              <th scope="col" className={`${TH} ${WIDE}`}>
                Output
              </th>
              <th scope="col" className={`${TH} ${WIDE}`}>
                Cache read
              </th>
              <th scope="col" className={`${TH} ${WIDE}`}>
                Cache write
              </th>
              {anyWeb && (
                <th scope="col" className={`${TH} ${WIDE}`}>
                  Web searches
                </th>
              )}
              {anyCost && (
                <th scope="col" className={`${TH} max-sm:w-24`}>
                  Cost
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {models.map((m) => {
              const pct = max > 0 ? Math.max(2, Math.round((m.totalTokens / max) * 100)) : 0;
              return (
                <tr key={m.model}>
                  <th scope="row" className={`${TD} font-normal max-sm:max-w-0 sm:w-[30%]`}>
                    {/* A model id is machine text, so it keeps the mono face. */}
                    <span className="block truncate font-mono text-small text-ink" title={m.model}>
                      {shortModel(m.model)}
                    </span>
                    <span aria-hidden="true" className="mt-2 block h-1 rounded-full bg-ground-2">
                      <span
                        className="block h-full rounded-full bg-ink-dim/55 transition-[width] duration-(--duration-slow) ease-(--ease-out-expo)"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    {/* The split, on a phone: each figure keeps its unit, and the
                        line wraps between pairs, never inside one. */}
                    <Folded
                      parts={[
                        `${compact(m.inputTokens)} in`,
                        `${compact(m.outputTokens)} out`,
                        `${compact(m.cacheReadTokens)} cache read`,
                        `${compact(m.cacheCreationTokens)} cache write`,
                        ...(anyWeb
                          ? [
                              `${m.webSearchRequests.toLocaleString()} search${m.webSearchRequests === 1 ? "" : "es"}`,
                            ]
                          : []),
                      ]}
                    />
                  </th>
                  <td className={`${TD} font-semibold text-ink`}>{compact(m.totalTokens)}</td>
                  <td className={`${DIM} ${WIDE}`}>{compact(m.inputTokens)}</td>
                  <td className={`${DIM} ${WIDE}`}>{compact(m.outputTokens)}</td>
                  <td className={`${DIM} ${WIDE}`}>{compact(m.cacheReadTokens)}</td>
                  <td className={`${DIM} ${WIDE}`}>{compact(m.cacheCreationTokens)}</td>
                  {anyWeb && (
                    <td className={`${DIM} ${WIDE}`}>{m.webSearchRequests.toLocaleString()}</td>
                  )}
                  {anyCost && <td className={DIM}>{usd(m.costUSD)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The 24 hours of a day, with the hours nobody worked drawn as the zero they are. */
function HourChart({ peaks }: { peaks: PeakHour[] }) {
  const byHour = new Map(peaks.map((p) => [p.hour, p.count]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: byHour.get(hour) ?? 0 }));
  const max = Math.max(0, ...hours.map((h) => h.count));
  const busiest = hours.reduce((a, h) => (h.count > a.count ? h : a), hours[0]);
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return (
    <div className="rounded-tile border border-line bg-surface shadow-raised">
      <p className="border-b border-line px-4 py-2.5 text-small text-ink-dim">
        Busiest at <strong className="font-semibold text-ink">{hh(busiest.hour)}</strong> ·{" "}
        {busiest.count} session{busiest.count === 1 ? "" : "s"} started then
      </p>
      <div className="px-4 pb-3 pt-4">
        <div className="relative h-28">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-line-strong"
          />
          <div className="absolute inset-0 flex items-end gap-0.5">
            {hours.map((h) => (
              <div
                key={h.hour}
                role="img"
                aria-label={`${hh(h.hour)}: ${h.count} session${h.count === 1 ? "" : "s"}`}
                title={`${hh(h.hour)} · ${h.count} session${h.count === 1 ? "" : "s"}`}
                className="group flex h-full min-w-0 flex-1 items-end justify-center"
              >
                <div
                  className={`w-full max-w-6 rounded-t-[4px] transition-colors duration-(--duration-quick) group-hover:bg-ink ${
                    h.hour === busiest.hour && h.count > 0 ? "bg-ink-dim/85" : "bg-ink-faint/55"
                  }`}
                  style={{
                    height:
                      h.count === 0 ? "2px" : `${Math.max(4, Math.round((h.count / max) * 100))}%`,
                  }}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="relative mt-2 h-4" aria-hidden="true">
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
            <span
              key={h}
              className={`absolute -translate-x-1/2 text-micro text-ink-faint ${h % 6 === 0 ? "" : "hidden sm:block"}`}
              style={{ left: `${((h + 0.5) / 24) * 100}%` }}
            >
              {hh(h)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The last 30 calendar days, oldest on the left — the same direction as
 * Budget's ledger, so the two "last 30 days" read alike, and read the same way:
 * hover a column, or focus the plot and arrow through it, and the header reads
 * that day out. The header is a live region only while the plot has focus, so a
 * pointer sweeping across it does not narrate thirty days.
 *
 * The cache only lists days that saw use, so the quiet days are filled in as
 * zeros rather than closing up the gaps and making a sparse month look busy.
 */
function DailyChart({ daily }: { daily: DailyStat[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const days = useMemo(() => {
    const last = daily[daily.length - 1]?.date;
    if (!last) return [];
    const byDate = new Map(daily.map((d) => [d.date.slice(0, 10), d]));
    const end = new Date(`${last.slice(0, 10)}T00:00:00`);
    return Array.from({ length: 30 }, (_, i) => {
      const d = new Date(end);
      d.setDate(end.getDate() - (29 - i));
      const key = localDay(d);
      return byDate.get(key) ?? { date: key, messages: 0, sessions: 0, toolCalls: 0, tokens: 0 };
    });
  }, [daily]);
  if (days.length === 0) return null;
  // Tokens when the telemetry has them; messages, which the transcripts always
  // carry, when it does not.
  const byTokens = days.some((d) => d.tokens > 0);
  const value = (d: DailyStat) => (byTokens ? d.tokens : d.messages);
  const unit = byTokens ? "tokens" : "messages";
  // The usage report lags the transcripts, so the newest days can have
  // messages and no tokens yet. Drawn as a zero they would read as quiet days;
  // they are marked as waiting instead.
  const unreported = (d: DailyStat) => byTokens && d.tokens === 0 && d.messages > 0;
  const anyUnreported = days.some(unreported);
  const max = Math.max(0, ...days.map(value));
  const total = days.reduce((n, d) => n + value(d), 0);
  const activeDays = days.filter((d) => value(d) > 0 || unreported(d)).length;
  const lastIndex = days.length - 1;
  const labelled = new Set([0, 7, 14, 21, lastIndex]);
  const shown = active === null ? null : days[active];
  const describe = (d: DailyStat) =>
    unreported(d)
      ? `${d.messages.toLocaleString()} messages · tokens not reported yet`
      : `${compact(value(d))} ${unit} · ${d.messages.toLocaleString()} messages`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    setActive((i) =>
      Math.max(0, Math.min(lastIndex, (i ?? lastIndex + (step > 0 ? -1 : 1)) + step)),
    );
  };

  return (
    <div className="rounded-tile border border-line bg-surface shadow-raised">
      <div
        className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-2.5"
        aria-live={focused ? "polite" : "off"}
      >
        <p className="text-small text-ink-dim">
          {shown ? (
            unreported(shown) ? (
              <>
                <strong className="font-semibold text-ink">
                  {shown.messages.toLocaleString()}
                </strong>{" "}
                messages on {shortDate(shown.date)} · tokens not reported yet
              </>
            ) : (
              <>
                <strong className="font-semibold text-ink">{compact(value(shown))}</strong> {unit}{" "}
                on {shortDate(shown.date)} · {shown.messages.toLocaleString()} messages ·{" "}
                {shown.sessions} session{shown.sessions === 1 ? "" : "s"}
              </>
            )
          ) : (
            <>
              <strong className="font-semibold text-ink">{compact(total)}</strong> {unit} across{" "}
              {activeDays} active day{activeDays === 1 ? "" : "s"}, to{" "}
              {shortDate(days[lastIndex].date)}
            </>
          )}
        </p>
        {anyUnreported && (
          <span className="inline-flex items-center gap-1.5 text-caption text-ink-faint">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-sm border border-dashed border-ink-faint"
            />
            Tokens not reported yet
          </span>
        )}
      </div>
      <div className="px-4 pb-3 pt-4">
        <div
          role="group"
          aria-label={`Daily ${unit}, last 30 days. Use the arrow keys to read each day.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setActive(null);
          }}
          onMouseLeave={() => setActive(null)}
          className="relative h-28 rounded-sm focus-visible:outline-offset-4"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-line-strong"
          />
          <div className="absolute inset-0 flex items-end gap-0.5">
            {days.map((d, i) => {
              const pending = unreported(d);
              return (
                <div
                  key={d.date}
                  onMouseEnter={() => setActive(i)}
                  title={`${d.date} · ${describe(d)}`}
                  className="flex h-full min-w-0 flex-1 items-end justify-center"
                >
                  {pending ? (
                    <div
                      className={`h-2 w-full max-w-6 rounded-t-[4px] border border-b-0 border-dashed transition-colors duration-(--duration-quick) ${
                        active === i ? "border-ink" : "border-ink-faint"
                      }`}
                    />
                  ) : (
                    <div
                      className={`w-full max-w-6 rounded-t-[4px] transition-colors duration-(--duration-quick) ${
                        active === i ? "bg-ink" : "bg-ink-faint/55"
                      }`}
                      style={{
                        height:
                          value(d) === 0
                            ? "2px"
                            : `${Math.max(3, Math.round((value(d) / max) * 100))}%`,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="relative mt-2 h-4" aria-hidden="true">
          {days.map((d, i) =>
            labelled.has(i) ? (
              <span
                key={d.date}
                className={`absolute whitespace-nowrap text-micro text-ink-faint ${
                  i === 0 ? "" : i === lastIndex ? "-translate-x-full" : "-translate-x-1/2"
                }`}
                style={{
                  left:
                    i === 0
                      ? "0%"
                      : i === lastIndex
                        ? "100%"
                        : `${((i + 0.5) / days.length) * 100}%`,
                }}
              >
                {shortDate(d.date)}
              </span>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}

export default function Stats() {
  const { stats, loading, error, refresh } = useStats();

  return (
    <Page
      title="Stats"
      subtitle={
        <>
          Claude Code&apos;s own usage across every project, interactive sessions included.
          {/* A line of its own at the left edge, so the explanation opens into
              the page at every width rather than off the side of a phone. */}
          <span className="mt-1 block text-caption text-ink-faint">
            <InfoTip
              title="About these numbers"
              trigger="Where these numbers come from"
              footer={
                <>
                  What the runs Argus launched cost is a different ledger, under{" "}
                  <a
                    href="#/budget"
                    className="font-semibold text-ink underline underline-offset-2"
                  >
                    Budget
                  </a>
                  .
                </>
              }
            >
              Claude Code&apos;s own telemetry, read from the usage cache the CLI keeps under
              ~/.claude. Sessions and messages come from the transcripts; tokens, cost and models
              from the CLI&apos;s usage report, which can lag behind or be missing entirely.
            </InfoTip>
            {/* After the trigger, not before it: the popover opens from the
                trigger's left edge, which has to be the page's. */}
            {stats?.lastComputedDate && <> · computed {stats.lastComputedDate}</>}
          </span>
        </>
      }
    >
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Stats"
            message={
              // A status code means the server answered and failed; anything
              // else (a rejected fetch) means it was never reached.
              /^HTTP \d{3}$/.test(error)
                ? `Couldn't load stats: ${error}`
                : `Couldn't reach the Argus server: ${error}`
            }
            action={
              <Button size="sm" icon="retry" onClick={() => refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      <Handoff
        busy={loading}
        label="stats"
        skeleton={
          <div className="mb-10 flex flex-col gap-10">
            {[0, 1].map((i) => (
              <div key={i}>
                <Skeleton className="mb-3 h-3 w-24" />
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-tile border border-line sm:grid-cols-4">
                  {[0, 1, 2, 3].map((j) => (
                    <div key={j} className="bg-surface px-4 py-3.5">
                      <Skeleton className="h-6 w-16" />
                      <Skeleton className="mt-2.5 h-2.5 w-20" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        }
      >
        {!stats || !stats.available ? (
          // An error has already said why there is nothing; an empty state under
          // it would claim the cache is empty, which nobody has checked.
          error ? null : (
            <div className="mb-10">
              <EmptyState
                icon="activity"
                title="No usage stats found yet"
                action={
                  <>
                    <Button icon="retry" onClick={() => refresh()}>
                      Check again
                    </Button>
                    <ButtonLink href="#/budget" variant="ghost" iconRight="arrow-right">
                      Argus run costs
                    </ButtonLink>
                  </>
                }
              >
                Argus reads Claude Code&apos;s own usage cache under{" "}
                <code className="font-mono text-caption text-ink">~/.claude</code>, which the CLI
                writes as you work. Use Claude Code on this machine and the numbers appear here.
              </EmptyState>
            </div>
          )
        ) : (
          <>
            {hasSessionData(stats.headline) && (
              <Section title="Sessions">
                <StatStrip>
                  <Stat label="Sessions" value={compact(stats.headline.totalSessions)} />
                  <Stat label="Messages" value={compact(stats.headline.totalMessages)} />
                  <Stat label="Tool calls" value={compact(stats.headline.totalToolCalls)} />
                  <Stat label="Active days" value={`${stats.headline.activeDays}`} />
                  {stats.longestSession && (
                    <Stat
                      label="Longest session"
                      value={fmtDuration(stats.longestSession.durationMs)}
                      hint={`${stats.longestSession.messageCount} messages`}
                    />
                  )}
                  {stats.firstSessionDate && (
                    <Stat
                      label="First session"
                      value={new Date(stats.firstSessionDate).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    />
                  )}
                </StatStrip>
              </Section>
            )}

            {/* Tokens, cost and model counts come from Claude Code's own usage
              telemetry rather than the transcripts, so it can be absent while the
              session counts above are real. Six zeros in that case would read as
              "you have used no tokens in 184 sessions", which never happens. */}
            <Section title="Tokens and cost">
              {hasTokenData(stats.headline) ? (
                <StatStrip>
                  <Stat label="Total tokens" value={compact(stats.headline.totalTokens)} />
                  <Stat label="Output tokens" value={compact(stats.headline.totalOutputTokens)} />
                  <Stat label="Cache reads" value={compact(stats.headline.totalCacheReadTokens)} />
                  <Stat label="Models used" value={`${stats.headline.modelsUsed}`} />
                  {stats.headline.totalCostUSD > 0 && (
                    <Stat label="Total cost" value={usd(stats.headline.totalCostUSD)} />
                  )}
                </StatStrip>
              ) : (
                <EmptyState compact icon="clock">
                  No token or cost telemetry yet. Argus reads it from Claude Code&apos;s own usage
                  cache; it appears here once the CLI has written a usage report. The session counts
                  above come from the transcripts and do not depend on it.
                </EmptyState>
              )}
            </Section>

            {stats.models.length > 0 && (
              <Section title="By model">
                <ModelTable models={stats.models} />
              </Section>
            )}

            {(stats.peakHours.length > 0 || stats.daily.length > 0) && (
              <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
                {stats.daily.length > 0 && (
                  <Section title="Daily activity · last 30 days">
                    <DailyChart daily={stats.daily} />
                  </Section>
                )}
                {stats.peakHours.length > 0 && (
                  <Section title="Activity by hour">
                    <HourChart peaks={stats.peakHours} />
                  </Section>
                )}
              </div>
            )}
          </>
        )}
      </Handoff>

      {/* Stats reads a rolling cache Claude Code maintains; the quarter view
          below reads the Vault, which keeps every run Argus has ever fired.
          Two sources, so the section says which one it came from. */}
      <VaultPanels />
    </Page>
  );
}
