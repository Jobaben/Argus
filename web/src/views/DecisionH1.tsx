import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type {
  H1Agreement,
  H1BaselineRow,
  H1Census,
  H1CollectionStatus,
  H1ModelPopulation,
  H1Population,
  H1Report,
  H1VerdictRow,
  H2Distribution,
  H2Finding,
  H2Proportion,
  H2Usage,
} from "@argus/contracts";
import { useDecisionH1 } from "../useDecisionH1";
import {
  RUNNER_DEFAULT,
  formatInterval,
  formatMeasured,
  formatNullable,
  formatProportion,
  pct,
  rate,
  unmeasuredBucket,
} from "./decisionFormat";
import {
  AlertStrip,
  Button,
  Card,
  EmptyState,
  Handoff,
  Icon,
  Section,
  SkeletonRows,
  chipClass,
  formatUsd,
  type IconName,
} from "../ds";
import { loadError } from "../live/loadError";

// ── Formatting ──────────────────────────────────────────────────────────────

const formatDistribution = (d: H2Distribution, unit: string): string =>
  d.n === 0
    ? "— (n = 0)"
    : `p50 ${d.p50 ?? "—"} · p95 ${d.p95 ?? "—"}${d.max !== null ? ` · max ${d.max}` : ""} ${unit} (n = ${d.n})`;

function formatTotals(
  t: { total: number; meanKnown: number | null; known: number; unknown: number },
  show: (n: number) => string,
): string {
  const mean = t.meanKnown === null ? "—" : show(t.meanKnown);
  return `total ${show(t.total)} · mean ${mean} (known ${t.known}, unknown ${t.unknown})`;
}

const POPULATION_LABEL: Record<H1Population, string> = {
  manual: "Manual gates",
  "auto-approve-declared": "Gates declaring autoApprove",
};

const populationLabel = (p: H1Population): string => POPULATION_LABEL[p] ?? p;

const referenceLabel = (l: string): string => l.replace(/-/g, " ");

// ── The report kit ──────────────────────────────────────────────────────────
//
// Shared with the H2 report in `DecisionExperiments.tsx`, so the two
// experiments on the page read as one instrument: the same facts list, tables,
// meters and empty rows. Plain ink throughout — no figure here is a pass/fail
// signal, and colouring one green would be exactly the verdict these reports
// refuse to give.

/**
 * Label/value rows, stacked on a phone and in two columns from `sm` up. The
 * value is always the label's next sibling, so a row reads as a pair to
 * assistive tech as well as to the eye. `columns={2}` lays short rows (an
 * identity, usage) out side by side on a wide screen.
 */
export function Facts({
  rows,
  columns = 1,
}: {
  rows: Array<[string, ReactNode]>;
  columns?: 1 | 2;
}) {
  return (
    <dl className={columns === 2 ? "grid lg:grid-cols-2 lg:gap-x-10" : ""}>
      {rows.map(([label, value]) => (
        <div
          key={label}
          className={`grid gap-x-4 gap-y-0.5 border-t border-line/60 py-1.5 first:border-t-0 sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] ${
            columns === 2 ? "lg:[&:nth-child(2)]:border-t-0" : ""
          }`}
        >
          <dt className="text-small text-ink-faint">{label}</dt>
          <dd className="min-w-0 break-words text-small text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Counts as small tiles: the number first, its label under it. A zero is
 * dimmed rather than coloured — on a fresh install every tile is zero, and a
 * row of loud zeros says nothing. A tile shown as text (an amount of money)
 * passes the number it stands for as a third element, so its zero dims too.
 */
const STAT_COLS = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
} as const;

export function StatGrid({
  items,
  cols = 4,
}: {
  items: Array<[label: string, value: number | string, raw?: number]>;
  /** Tiles per row on a wide screen; a phone always has two. */
  cols?: keyof typeof STAT_COLS;
}) {
  return (
    <dl className={`grid gap-2 ${STAT_COLS[cols]}`}>
      {items.map(([label, value, raw]) => (
        // DOM order is label then value, so the value stays the label's next
        // sibling; `flex-col-reverse` puts the number on top.
        <div
          key={label}
          className="flex flex-col-reverse justify-end gap-1.5 rounded-control bg-ground-2/70 px-3 py-2.5"
        >
          <dt className="text-caption text-ink-faint">{label}</dt>
          <dd
            className={`text-title font-semibold leading-none ${
              (raw ?? value) === 0 ? "text-ink-faint" : "text-ink"
            }`}
          >
            {String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Counts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return <>none</>;
  return <>{entries.map(([k, v]) => `${k}: ${v}`).join(" · ")}</>;
}

/**
 * A heading inside a card. An `h4` under the card's own `h3` title; a card
 * with no title of its own (collection, integrity) passes `level={3}`, so the
 * outline does not skip from the section's `h2`.
 */
export function SubHeading({ children, level = 4 }: { children: ReactNode; level?: 3 | 4 }) {
  const H = level === 3 ? "h3" : "h4";
  return <H className="mb-2.5 text-small font-semibold text-ink">{children}</H>;
}

/**
 * A card's title, one anatomy for every card in both experiments: what the
 * card is about in words, the machine id it is about beside it in mono, and a
 * count at the far end. They used to be set four ways — an id as the heading,
 * a chip inside one, a label with the id under it, a label alone.
 */
export function CardTitle({
  children,
  id,
  aside,
}: {
  children: ReactNode;
  id?: string;
  aside?: ReactNode;
}) {
  return (
    <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="min-w-0 break-words text-heading font-semibold text-ink">{children}</h3>
      {id && <p className="min-w-0 break-all font-mono text-caption text-ink-faint">{id}</p>}
      {aside != null && <p className="ml-auto text-small text-ink-dim">{aside}</p>}
    </header>
  );
}

/** A titled region inside a card, set off from the one above by a hairline. */
export function Block({
  title,
  level,
  children,
}: {
  title?: ReactNode;
  level?: 3 | 4;
  children: ReactNode;
}) {
  return (
    <div className="mt-5 border-t border-line pt-4">
      {title != null && <SubHeading level={level}>{title}</SubHeading>}
      {children}
    </div>
  );
}

/** A section with nothing in it yet: one quiet line, not a hero empty state. */
export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-tile border border-line bg-surface/50 px-4 py-3 text-small text-ink-faint">
      {children}
    </p>
  );
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="text-small text-ink-faint">{children}</p>;
}

export function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-caption text-ink-faint">{children}</p>;
}

/**
 * Whether collection is on, in the anatomy of `StatusPill`. Neutral either
 * way, like every figure in these reports: green would read as "good", and
 * collecting is a setting, not a result. On is brighter ink with a filled dot;
 * off is dimmer with an empty one.
 */
export function StatePill({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-6 items-center gap-1.5 rounded-full border border-line-strong pl-2 pr-2.5 text-caption font-semibold ${
        on ? "bg-surface-2 text-ink" : "bg-ink-faint/8 text-ink-dim"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${on ? "bg-current" : "border border-current"}`}
      />
      {children}
    </span>
  );
}

/** The head of one experiment: what it asks, in a sentence. */
export function ExperimentHeader({
  id,
  icon,
  title,
  children,
}: {
  id: string;
  icon: IconName;
  title: string;
  children: ReactNode;
}) {
  return (
    <header className="mb-5 flex items-start gap-3.5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-tile border border-line-strong bg-surface-2 text-ink-dim shadow-raised">
        <Icon name={icon} size={20} />
      </span>
      <div className="min-w-0 pt-0.5">
        <h2 id={id} className="text-title font-semibold text-ink">
          {title}
        </h2>
        <p className="mt-0.5 max-w-3xl text-small text-ink-dim">{children}</p>
      </div>
    </header>
  );
}

/** The shadow-only caveat that heads each experiment. */
export function Notice({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div
      role="note"
      className="mb-8 flex gap-3 rounded-tile border border-line bg-ground-2/60 px-4 py-3.5"
    >
      <Icon name="shield" size={18} className="mt-0.5 text-ink-dim" />
      <div className="min-w-0 text-small leading-relaxed">
        <p className="font-semibold text-ink">{title}</p>
        <p className="mt-1 text-ink-dim">{children}</p>
      </div>
    </div>
  );
}

/**
 * A proportion's value, with a meter beside it: the point estimate as a tick and
 * the 95% interval as the band around it. A row of percentages reads as equally
 * certain; the band is what says 62% of 8 is a guess and 62% of 800 is not.
 *
 * No interval, no meter. A lone tick on an empty track looks *more* certain
 * than one with a band, which is the opposite of the truth; the figure alone,
 * without its "95% CI", says what is known.
 */
export function ProportionValue({ p }: { p: H2Proportion }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {/* A fixed width for the figure from `sm` up, so the meters down a list
          line up; on a phone the figure takes the line and the meter sits
          under it, left-aligned with the others. */}
      <span className="w-full sm:w-auto sm:min-w-56">{formatProportion(p)}</span>
      {p.value !== null && p.ci95 && (
        <span
          aria-hidden="true"
          className="relative block h-1.5 w-28 shrink-0 rounded-full bg-ink-faint/15"
        >
          <span
            className="absolute inset-y-0 rounded-full bg-ink-faint/45"
            style={{ left: `${p.ci95[0] * 100}%`, width: `${(p.ci95[1] - p.ci95[0]) * 100}%` }}
          />
          <span
            className="absolute -top-[3px] h-3 w-0.5 -translate-x-1/2 rounded-full bg-ink"
            style={{ left: `${p.value * 100}%` }}
          />
        </span>
      )}
    </span>
  );
}

// Table cells. Numbers are Hellix tabular, not monospace: they are figures to
// compare down a column, not machine text.
export const TH = "pb-2 pr-4 text-right align-bottom text-caption font-semibold text-ink-faint";
export const TH_LEFT = "pb-2 pr-4 text-left align-bottom text-caption font-semibold text-ink-faint";
export const TD = "py-2 pr-4 text-right tabular-nums text-ink";
export const TD_LEFT = "py-2 pr-4 text-left text-ink";

/**
 * The sideways-scrolling frame a wide table sits in on a phone, so the table
 * scrolls instead of the page.
 *
 * It bleeds to the card's edge (`-mx-4 px-4` is `Card`'s padding), so the clip
 * falls on the card border rather than a few pixels inside it, where a header
 * cut mid-word looked like a rendering bug. And the edge with more behind it
 * fades, which is what says "this scrolls". The fade is set from the scroll
 * position directly on the element: it follows the finger, and a re-render per
 * scroll event would buy nothing. A line under the frame says the same in
 * words while there is more to see.
 */
function ScrollFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.dataset.fade = `${el.scrollLeft > 1 ? "s" : ""}${el.scrollLeft < max - 1 ? "e" : ""}`;
      el.dataset.more = String(el.scrollLeft < max - 1);
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // The frame's width follows the viewport and the table's follows its data.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, []);
  return (
    <div>
      <div
        ref={ref}
        className="peer -mx-4 overflow-x-auto px-4 data-[fade=e]:[mask-image:linear-gradient(to_right,black_calc(100%_-_2.5rem),transparent)] data-[fade=s]:[mask-image:linear-gradient(to_right,transparent,black_2.5rem)] data-[fade=se]:[mask-image:linear-gradient(to_right,transparent,black_2.5rem,black_calc(100%_-_2.5rem),transparent)]"
      >
        {children}
      </div>
      {/* The fade alone is easy to read as a rendering fault; while there is
          more to the right, say so in words. */}
      <p
        aria-hidden="true"
        className="mt-1.5 hidden items-center justify-end gap-1 text-caption text-ink-faint peer-data-[more=true]:flex"
      >
        Scroll sideways for more
        <Icon name="arrow-right" size={13} />
      </p>
    </div>
  );
}

/** A data table, in a frame that scrolls sideways when it is wider than the card. */
export function DataTable({
  caption,
  head,
  children,
  minWidth = "min-w-[28rem]",
}: {
  caption: string;
  head: ReactNode;
  children: ReactNode;
  minWidth?: string;
}) {
  return (
    <ScrollFrame>
      <table className={`w-full border-collapse text-small ${minWidth}`}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line-strong">{head}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </ScrollFrame>
  );
}

export function Th({ children, left = false }: { children: ReactNode; left?: boolean }) {
  return (
    <th scope="col" className={left ? TH_LEFT : TH}>
      {children}
    </th>
  );
}

/**
 * A confusion matrix as a heat map: each cell's tint is its share of the
 * largest cell, so where the answers pile up is visible before any number is
 * read. Neutral ink, not a status colour — a full cell is not a good cell.
 */
export function Matrix({
  caption,
  corner,
  columns,
  rows,
  counts,
  rowLabel = (r) => r,
}: {
  caption: string;
  corner: string;
  columns: string[];
  rows: string[];
  counts: number[][];
  rowLabel?: (row: string) => string;
}) {
  const max = Math.max(0, ...counts.flat());
  const tint = (n: number) => {
    if (n === 0 || max === 0) return "text-ink-faint";
    const r = n / max;
    return r > 0.75
      ? "bg-ink/22 text-ink"
      : r > 0.5
        ? "bg-ink/16 text-ink"
        : r > 0.25
          ? "bg-ink/11 text-ink"
          : "bg-ink/6 text-ink";
  };
  // Every answer column is the same width, so the tints compare as areas and
  // "insufficient-data" beside "flag" no longer stretches one cell to three
  // times another. The narrowest a column may get is the longest word its
  // header has to hold (headers wrap at their hyphens): about 0.38rem a
  // character at caption size, plus padding. Three short answers fit a phone;
  // longer or more answers scroll in the frame.
  const longestWord = Math.max(4, ...columns.flatMap((c) => c.split("-").map((w) => w.length)));
  const colRem = Math.min(7, 0.6 + longestWord * 0.38);
  const minRem = 6.5 + columns.length * colRem + (columns.length + 2) * 0.25;
  return (
    <ScrollFrame>
      <table
        className="w-full max-w-2xl table-fixed border-separate border-spacing-1 text-small"
        style={{ minWidth: `${minRem.toFixed(2)}rem` }}
      >
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col className="w-26 sm:w-36" />
          {columns.map((col) => (
            <col key={col} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th
              scope="col"
              className="px-2 pb-1 text-left align-bottom text-caption font-semibold text-ink-faint"
            >
              {corner}
            </th>
            {columns.map((col) => (
              <th
                key={col}
                scope="col"
                className="break-words px-1 pb-1 text-center align-bottom text-caption font-semibold text-ink-faint"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row}>
              <th scope="row" className="break-words px-2 py-2 text-left font-normal text-ink-dim">
                {rowLabel(row)}
              </th>
              {columns.map((col, j) => {
                const n = counts[i]?.[j] ?? 0;
                return (
                  <td
                    key={col}
                    className={`rounded-md bg-ground-2/70 px-2 py-2 text-center tabular-nums ${tint(n)}`}
                  >
                    {n}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollFrame>
  );
}

/** An environment variable's name in a sentence. */
const ENV_NAME = /\b(ARGUS_[A-Z0-9_]+)\b/g;

/**
 * A reason as the server words it, with any environment variable named in it
 * set as the machine text it is: mono, and free to wrap only after an
 * underscore, so a narrow column breaks it into words rather than mid-word.
 */
export function ReasonText({ text }: { text: string }) {
  return (
    <>
      {text.split(ENV_NAME).map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-caption text-ink">
            {part.split("_").map((word, j, all) => (
              <Fragment key={j}>
                {word}
                {j < all.length - 1 && (
                  <>
                    _<wbr />
                  </>
                )}
              </Fragment>
            ))}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * The watcher's state. When its detail only repeats the reasons collection is
 * off — listed in full beside it — the state stands alone and points at them.
 */
export function WatcherValue({
  watcher: w,
  enabled,
  reasons,
}: {
  watcher: { state: string; detail: string | null; until: string | null };
  enabled: boolean;
  reasons: string[];
}) {
  if (!enabled && w.detail != null && w.detail === reasons.join("; ")) {
    return (
      <>
        {w.state} <span className="text-ink-faint">· see the reasons below</span>
      </>
    );
  }
  return (
    <>{`${w.state}${w.detail ? ` — ${w.detail}` : ""}${w.until ? ` (until ${w.until})` : ""}`}</>
  );
}

/**
 * How to turn collection on, from the reasons it is off: each switch that is
 * not on, as the line that sets it. Anything else the server reported (a bad
 * setting) follows as it was said.
 */
export function TurnOnCollection({ reasons, then }: { reasons: string[]; then: ReactNode }) {
  const switches = reasons
    .map((r) => /^(ARGUS_[A-Z0-9_]+) is not (?:on|set)$/.exec(r)?.[1])
    .filter((name): name is string => name != null);
  const other = reasons.filter((r) => !/^(ARGUS_[A-Z0-9_]+) is not (?:on|set)$/.test(r));
  return (
    <div className="flex flex-col items-center gap-3">
      <p>
        Collection is off. It calls a model, so it stays off until you turn it on
        {switches.length > 0 ? " — set these where Argus starts, then restart it:" : "."}
      </p>
      {switches.length > 0 && (
        <pre className="w-full max-w-sm overflow-x-auto rounded-control border border-line bg-ground-2 px-3 py-2.5 text-left font-mono text-caption leading-relaxed text-ink">
          <code>{switches.map((name) => `${name}=on`).join("\n")}</code>
        </pre>
      )}
      {other.length > 0 && (
        <ul className="flex flex-col gap-1 text-left">
          {other.map((r) => (
            <li key={r} className="flex items-start gap-2">
              <Icon name="alert" size={14} className="mt-[3px] shrink-0 text-ink-faint" />
              <span className="min-w-0 break-words">
                <ReasonText text={r} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-ink-faint">{then}</p>
    </div>
  );
}

/**
 * The rest of a report that has nothing in it yet: what the experiment is
 * built from and how it measures, and the census and checks that are all zero
 * until something is collected. Closed, so a first visit reads as "here is how
 * to turn this on" rather than as thousands of pixels of zeros.
 */
export function ReportDetails({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <details className="group mb-10">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-tile border border-line bg-surface px-4 py-3 shadow-raised transition-colors duration-(--duration-quick) hover:border-line-strong [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-small font-semibold text-ink">
            <Icon name="layers" size={15} className="text-ink-faint" />
            What this experiment measures
          </span>
          <span className="mt-0.5 block text-caption text-ink-faint">{hint}</span>
        </span>
        <Icon
          name="chevron-down"
          size={16}
          className="shrink-0 text-ink-faint transition-transform duration-(--duration-quick) group-open:rotate-180"
        />
      </summary>
      <div className="pt-8">{children}</div>
    </details>
  );
}

/** Settings as recorded, beside whether collection runs and why not. */
export function CollectionCard({
  state,
  enabled,
  reasons,
  settings,
  children,
}: {
  state: Array<[string, ReactNode]>;
  enabled: boolean;
  reasons: string[];
  /** Null when the settings did not parse; the reasons say why. */
  settings: Array<[string, ReactNode]> | null;
  /** The recorded collection configs, under a rule: a `Block` with `level={3}`,
   *  since this card has no title of its own. */
  children?: ReactNode;
}) {
  return (
    <Card>
      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
        <div className="min-w-0">
          <Facts rows={state} />
          {!enabled && (
            <div className="mt-4">
              <SubHeading level={3}>Reasons collection is off</SubHeading>
              {reasons.length === 0 ? (
                <EmptyLine>No reason reported</EmptyLine>
              ) : (
                <ul className="flex flex-col gap-1.5 rounded-control bg-ground-2/70 px-3 py-2.5">
                  {reasons.map((r) => (
                    <li key={r} className="flex items-start gap-2 text-small text-ink">
                      <Icon name="minus" size={14} className="mt-[3px] text-ink-faint" />
                      <span className="min-w-0 break-words">
                        <ReasonText text={r} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <SubHeading level={3}>Settings</SubHeading>
          {settings ? <Facts rows={settings} /> : <EmptyLine>No valid settings</EmptyLine>}
        </div>
      </div>
      {children}
    </Card>
  );
}

/** One recorded collection config: an inset well inside the collection card. */
export function ConfigWell({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className="rounded-control bg-ground-2/60 px-3 py-1.5">
      <Facts rows={rows} columns={2} />
    </div>
  );
}

export function UsageFacts({ usage }: { usage: H2Usage }) {
  return (
    <Block title="Usage">
      <Facts
        columns={2}
        rows={[
          ["Latency", formatDistribution(usage.latencyMs, "ms")],
          ["Cost (USD)", formatTotals(usage.costUsd, formatUsd)],
          ["Tokens", formatTotals(usage.tokens, (n) => String(Math.round(n * 10) / 10))],
          ["Snapshot size", formatDistribution(usage.snapshotBytes, "bytes")],
        ]}
      />
    </Block>
  );
}

function FindingRows({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-line rounded-control bg-ground-2/60">{children}</ul>;
}

function FindingRow({ meta, detail }: { meta: ReactNode; detail: string }) {
  return (
    <li className="px-3 py-2">
      {meta}
      <p className="mt-0.5 text-small text-ink">{detail}</p>
    </li>
  );
}

const META = "font-mono text-caption text-ink-faint";

export function FindingList({ findings, empty }: { findings: H2Finding[]; empty: string }) {
  if (findings.length === 0) return <EmptyLine>{empty}</EmptyLine>;
  return (
    <FindingRows>
      {findings.map((f, i) => (
        <FindingRow
          key={i}
          detail={f.detail}
          meta={
            <span className={META}>
              {f.kind}
              {f.line !== null ? ` · line ${f.line}` : ""}
              {f.attemptId ? ` · ${f.attemptId}` : ""}
            </span>
          }
        />
      ))}
    </FindingRows>
  );
}

/** The ledger, journal and join checks, side by side on a wide screen. */
export function IntegrityCard({
  integrity,
  facts,
  empty,
}: {
  integrity: H1Report["integrity"];
  facts: Array<[string, ReactNode]>;
  empty: string;
}) {
  const notices = integrity.journal.notices;
  return (
    <Card>
      <Facts rows={facts} />
      <div className="mt-5 grid gap-x-6 gap-y-5 border-t border-line pt-4 lg:grid-cols-3">
        <div className="min-w-0">
          <SubHeading level={3}>Ledger findings</SubHeading>
          <FindingList findings={integrity.ledger} empty={empty} />
        </div>
        <div className="min-w-0">
          <SubHeading level={3}>Journal notices</SubHeading>
          {notices.length === 0 ? (
            <EmptyLine>{empty}</EmptyLine>
          ) : (
            <FindingRows>
              {notices.map((n, i) => (
                <FindingRow
                  key={i}
                  detail={n.detail}
                  meta={
                    <span className={META}>
                      {n.kind}
                      {n.segment ? ` · ${n.segment}` : ""}
                      {n.line !== null ? ` · line ${n.line}` : ""}
                    </span>
                  }
                />
              ))}
            </FindingRows>
          )}
        </div>
        <div className="min-w-0">
          <SubHeading level={3}>Findings</SubHeading>
          <FindingList findings={integrity.findings} empty={empty} />
        </div>
      </div>
    </Card>
  );
}

/**
 * How every figure is computed. Reference text, closed by default: it is the
 * longest thing in either report and the thing least often needed.
 */
export function MethodsPanel({ methods }: { methods: Record<string, string> }) {
  const entries = Object.entries(methods);
  if (entries.length === 0) return <EmptyRow>No method notes recorded</EmptyRow>;
  return (
    <details className="group rounded-tile border border-line bg-surface shadow-raised">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-tile px-4 py-3 text-small text-ink-dim transition-colors duration-(--duration-quick) hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <Icon name="file" size={15} className="text-ink-faint" />
          How each figure is computed
          <span className={chipClass()}>{entries.length}</span>
        </span>
        <Icon
          name="chevron-down"
          size={16}
          className="text-ink-faint transition-transform duration-(--duration-quick) group-open:rotate-180"
        />
      </summary>
      <dl className="grid gap-x-6 gap-y-3 border-t border-line px-4 py-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
        {entries.map(([key, text]) => (
          <div key={key} className="contents">
            <dt className="break-words font-mono text-caption text-ink-faint sm:pt-0.5">{key}</dt>
            <dd className="-mt-2 text-small text-ink-dim sm:mt-0">{text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** Where the report was read up to, and the promise that reading changed nothing. */
export function AsOf({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-caption text-ink-faint">
      <Icon name="history" size={14} className="mt-px" />
      <span>{children}</span>
    </p>
  );
}

// ── Collection ──────────────────────────────────────────────────────────────

function CollectionSection({
  status,
  collection,
}: {
  status: H1CollectionStatus;
  collection: H1Report["collection"];
}) {
  const s = status.settings;
  const w = status.watcher;
  return (
    <Section title="Collection">
      <CollectionCard
        enabled={status.enabled}
        reasons={status.reasons}
        state={[
          [
            "Collection",
            <StatePill on={status.enabled}>{status.enabled ? "On" : "Off"}</StatePill>,
          ],
          [
            "Watcher",
            <WatcherValue watcher={w} enabled={status.enabled} reasons={status.reasons} />,
          ],
          ["First collection", collection.start ?? "none recorded"],
        ]}
        // The order and words of H2's settings beside it: sampling, model,
        // call caps, interval, spend, seed.
        settings={
          s
            ? [
                ["Sampling rate", rate(s.rate)],
                [
                  "Requested models",
                  s.models.length === 0
                    ? "none"
                    : s.models.map((m) => m ?? RUNNER_DEFAULT).join(" · "),
                ],
                ["Combined max calls per 24h", String(s.maxCallsPer24h)],
                ["H1 own share per 24h", String(s.maxOwnCallsPer24h)],
                ["Min interval between calls", formatInterval(s.minCallIntervalMs)],
                ["Max spend per 24h", `$${s.maxUsdPer24h}`],
                ["Seed", <span className="font-mono">{s.seed}</span>],
              ]
            : null
        }
      >
        <Block title="Collection configs" level={3}>
          {collection.configs.length === 0 ? (
            <EmptyLine>No collection config recorded</EmptyLine>
          ) : (
            <div className="flex flex-col gap-2">
              {collection.configs.map((c) => (
                <ConfigWell
                  key={c.digest}
                  rows={[
                    ["Digest", <span className="font-mono">{c.digest.slice(0, 12)}</span>],
                    ["First recorded", c.firstAt],
                    ["Recorded sampling rate", rate(c.rate)],
                    [
                      "Arms (requested model)",
                      c.arms.length === 0
                        ? "none"
                        : c.arms.map((a) => a.requestedModel ?? RUNNER_DEFAULT).join(" · "),
                    ],
                  ]}
                />
              ))}
            </div>
          )}
        </Block>
      </CollectionCard>
    </Section>
  );
}

// ── Definitions ─────────────────────────────────────────────────────────────

/**
 * Whether a definition on disk is the registered one, set right after its id.
 * The normal answer is a quiet word; only a missing or changed definition gets
 * a chip, in red, because then every figure built on it is suspect.
 */
export function DefinitionStatus({
  status,
}: {
  status: "registered" | "missing" | "digest-mismatch";
}) {
  if (status === "registered") {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-ink-faint">
        <Icon name="check" size={13} />
        registered
      </span>
    );
  }
  return (
    <span className={chipClass("fail")}>
      <Icon name="alert" size={12} />
      {status}
    </span>
  );
}

/** What the experiment is built from, and whether each piece is the registered one. */
function DefinitionsSection({ definitions }: { definitions: H1Report["definitions"] }) {
  if (definitions.length === 0) return null;
  return (
    <Section title="Definitions">
      <ul className="divide-y divide-line rounded-tile border border-line bg-surface shadow-raised">
        {definitions.map((d) => (
          <li
            key={`${d.kind}:${d.id}@${d.version}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5"
          >
            <span className={`${chipClass()} w-24 justify-center`}>{d.kind}</span>
            <span className="min-w-0 break-all font-mono text-small text-ink">
              {d.id}@{d.version}
            </span>
            <DefinitionStatus status={d.status} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ── Pending, gate exclusions, spend ─────────────────────────────────────────

/** Gates that are counted and not shown: the ones H1 captured that are still
 *  waiting on an operator, and the pauses that were never captured at all. The
 *  ledger's count, not a live one — so the section says so, beside a Command
 *  Center that may well have a gate waiting right now. */
function PendingSection({
  pending,
  excluded,
}: {
  pending: H1Report["pending"];
  excluded: Record<string, number>;
}) {
  const populations = Object.entries(pending.byPopulation) as Array<[H1Population, number]>;
  return (
    <Section title="Captured gates still pending" className="flex flex-col">
      <Card className="flex-1">
        <StatGrid
          cols={3}
          items={[
            ["Pending gates (total)", pending.total],
            ...populations.map(([p, n]): [string, number] => [populationLabel(p), n]),
          ]}
        />
        <p className="mt-3 text-small text-ink-dim">
          Gate pauses seen and not captured: <Counts counts={excluded} />
        </p>
        <Caption>
          Only gates H1 captured while collection was on — not the gates waiting in Command Center
          now. Pending gates are counted, not shown: no pending gate, prediction or label is listed
          here.
        </Caption>
      </Card>
    </Section>
  );
}

function SpendSection({ spend }: { spend: H1Report["spend"] }) {
  return (
    <Section title="Spend" className="flex flex-col">
      <Card className="flex-1">
        <StatGrid
          cols={4}
          items={[
            ["Attempts", spend.attempts],
            // Attempts that reached the provider, so could have cost money —
            // a count, which "Spent" beside a dollar total read as a second sum.
            ["Provider calls", spend.spent],
            ["Total (USD)", formatUsd(spend.usdTotal), spend.usdTotal],
            ["Unknown cost", spend.usdUnknown],
          ]}
        />
        <Caption>Counts and money across all attempts, settled or not; never outcomes.</Caption>
      </Card>
    </Section>
  );
}

// ── Census ──────────────────────────────────────────────────────────────────

function CensusCard({ c }: { c: H1Census }) {
  return (
    <Card>
      <CardTitle>{populationLabel(c.population)}</CardTitle>
      <StatGrid
        cols={3}
        items={[
          ["Captured", c.captured],
          ["Sampled", c.sampled],
          ["Not sampled", c.notSampled],
          ["Pending", c.pending],
          ["Resolved", c.resolved],
          ["Window closed", c.windowClosed],
        ]}
      />
      <Block title="Operator labels">
        <StatGrid
          cols={3}
          items={[
            ["Labeled: sent back", c.labeled.sentBack],
            ["Labeled: not sent back", c.labeled.notSentBack],
            ["Labeled: approve", c.labeled.approve],
            ["Labeled: revise", c.labeled.revise],
            ["Labeled: abort", c.labeled.abort],
          ]}
        />
      </Block>
      <Block>
        <Facts
          rows={[
            ["Unlabeled reasons", <Counts counts={c.unlabeled} />],
            [
              "Review state",
              `held ${c.state.held} · changed ${c.state.changed} · unobserved ${c.state.unobserved}`,
            ],
            ["Principals", <Counts counts={c.principals} />],
            ["Not called (reasons)", <Counts counts={c.notCalled} />],
          ]}
        />
        <Caption>
          A session principal is an authenticated account, not proof that a person acted.
        </Caption>
      </Block>
    </Card>
  );
}

// ── Agreement ───────────────────────────────────────────────────────────────

/** The matrix and the agreement figures; side by side when there is room. */
function Agreement({ a, name, split = false }: { a: H1Agreement; name: string; split?: boolean }) {
  return (
    <div
      className={`grid gap-x-8 gap-y-3 ${split ? "xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" : ""}`}
    >
      <div className="min-w-0">
        <Matrix
          caption={`Confusion matrix for ${name}`}
          corner="Operator \ predicted"
          columns={a.confusion.columns}
          rows={a.confusion.rows}
          counts={a.confusion.counts}
          rowLabel={referenceLabel}
        />
      </div>
      <div className="min-w-0">
        <Facts
          rows={[
            ["Scored", String(a.scored)],
            ["Answered", String(a.answered)],
            ["Coverage", <ProportionValue p={a.coverage} />],
            ["Agreement with operator (answered)", <ProportionValue p={a.agreementAnswered} />],
            ["Agreement with operator (end-to-end)", <ProportionValue p={a.agreementEndToEnd} />],
            ["False close (predicts approve | sent back)", <ProportionValue p={a.falseClose} />],
            [
              "False escalation (predicts sent back | approved)",
              <ProportionValue p={a.falseEscalation} />,
            ],
            ["Cohen's κ", formatMeasured(a.kappa, (v) => v.toFixed(3))],
          ]}
        />
      </div>
    </div>
  );
}

// ── Baselines ───────────────────────────────────────────────────────────────

function BaselineRow({ row, children }: { row: H1BaselineRow; children?: ReactNode }) {
  const name = `${row.definition.id}@${row.definition.version}`;
  return (
    <Card>
      <CardTitle>{populationLabel(row.population)}</CardTitle>
      <Facts
        rows={[
          ["Definition", <span className="font-mono">{name}</span>],
          ["Scored", String(row.scored)],
        ]}
      />
      {children}
      <Block title="Agreement">
        <Agreement a={row.agreement} name={`${name} (${populationLabel(row.population)})`} />
      </Block>
    </Card>
  );
}

function VerdictRow({ row }: { row: H1VerdictRow }) {
  return (
    <BaselineRow row={row}>
      <div className="border-t border-line/60">
        <Facts
          rows={[
            [
              "AUROC",
              formatMeasured(
                row.auroc,
                (v) =>
                  `${v.value.toFixed(3)} (95% CI ${v.ci95[0].toFixed(3)}–${v.ci95[1].toFixed(3)}; ${v.sentBack} sent back / ${v.notSentBack} not sent back)`,
              ),
            ],
          ]}
        />
      </div>
    </BaselineRow>
  );
}

function BaselineSection({
  title,
  empty,
  caption,
  children,
}: {
  title: string;
  empty: string | null;
  caption: string;
  children: ReactNode;
}) {
  return (
    <Section title={title}>
      {empty !== null ? (
        <EmptyRow>{empty}</EmptyRow>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">{children}</div>
      )}
      <Caption>{caption}</Caption>
    </Section>
  );
}

// ── Models ──────────────────────────────────────────────────────────────────

function ModelCard({ p }: { p: H1ModelPopulation }) {
  const question = `${p.question.id}@${p.question.version}`;
  const name = `${question} (${populationLabel(p.population)})`;
  return (
    <Card>
      <CardTitle id={question}>{populationLabel(p.population)}</CardTitle>
      <Facts
        columns={2}
        rows={[
          ["Definition", p.question.definition],
          ["Projection", `${p.projection.id}@${p.projection.version}`],
          ["Provider", p.provider.provider],
          ["Requested model", p.provider.requestedModel ?? RUNNER_DEFAULT],
          ["Reported model", p.provider.reportedModel ?? "not reported"],
          ["Adapter version", String(p.provider.adapterVersion)],
          ["Elicitation", p.provider.elicitation],
        ]}
      />

      <Block title="Counts">
        <StatGrid
          items={[
            ["Assessed", p.assessed],
            ["Answered", p.answered],
            ["Abstained", p.abstained],
            ["Failed", p.failed],
          ]}
        />
        <div className="mt-3">
          <Facts
            rows={[
              ["Attempts by class", <Counts counts={p.attempts} />],
              ["Refusals (no provider call)", <Counts counts={p.refusals} />],
              ["Excluded from scoring", <Counts counts={p.excluded} />],
            ]}
          />
        </div>
      </Block>

      <Block title="Agreement">
        <Agreement a={p.agreement} name={name} split />
      </Block>

      <Block title="Calibration">
        <div className="grid gap-x-8 gap-y-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="min-w-0">
            <Facts
              rows={[
                ["Brier", formatMeasured(p.brier, (v) => `${v.value.toFixed(3)} (n = ${v.n})`)],
                ["ECE", formatMeasured(p.ece, (v) => `${v.value.toFixed(3)} (n = ${v.n})`)],
              ]}
            />
          </div>
          <div className="min-w-0">
            <SubHeading>Reliability (predicted probability of sent back)</SubHeading>
            <DataTable
              caption={`Reliability buckets for ${name}`}
              head={
                <>
                  <Th left>Bucket</Th>
                  <Th>n</Th>
                  <Th>Mean predicted</Th>
                  <Th>Observed rate</Th>
                </>
              }
            >
              {p.reliability.buckets.map((b) => (
                <tr key={b.lower}>
                  <td className={TD_LEFT}>
                    {b.lower}–{b.upper}
                  </td>
                  <td className={TD}>{b.n}</td>
                  {b.status === "measured" ? (
                    <>
                      <td className={TD}>{formatNullable(b.meanPredicted, (v) => v.toFixed(3))}</td>
                      <td className={TD}>{formatNullable(b.observedRate, (v) => pct(v))}</td>
                    </>
                  ) : (
                    <td colSpan={2} className={`${TD} text-ink-faint`}>
                      {unmeasuredBucket(b.n, p.reliability.minBucket)}
                    </td>
                  )}
                </tr>
              ))}
            </DataTable>
          </div>
        </div>
      </Block>

      <Block>
        <div className="grid gap-x-8 gap-y-5 xl:grid-cols-2">
          <div className="min-w-0">
            <SubHeading>Deterministic baseline on the same items</SubHeading>
            <Agreement a={p.paired.deterministic} name={`${name}, deterministic baseline`} />
          </div>
          <div className="min-w-0">
            <SubHeading>Verdict baseline on the same items</SubHeading>
            <Agreement a={p.paired.verdict} name={`${name}, verdict baseline`} />
          </div>
        </div>
      </Block>

      <UsageFacts usage={p.usage} />
    </Card>
  );
}

// ── Report ──────────────────────────────────────────────────────────────────

function Report({ data }: { data: NonNullable<ReturnType<typeof useDecisionH1>["data"]> }) {
  const { collection, report } = data;
  // Nothing in the ledger yet — the first-run state, and the default one,
  // since collection is off until someone turns it on. The report is all
  // zeros then, so it folds away behind the one thing worth saying.
  const empty = report.asOf.seq === 0 && report.models.length === 0;
  return (
    <>
      {/* H2's anatomy: a short title, then the caveat. The statement is the
          server's, shown verbatim. */}
      <Notice title="Shadow measurement only">
        These predictions are never read by any gate, badge, ordering or approval, and gates still
        waiting on an operator are shown only as counts. <span>{report.statement}</span>
      </Notice>

      <CollectionSection status={collection} collection={report.collection} />

      {empty ? (
        <>
          <Section title="Assessments">
            <EmptyState icon="inbox" title="No shadow assessments recorded">
              {collection.enabled ? (
                "Collection is on. A gate is captured when it pauses, and assessed once its operator settles it."
              ) : (
                <TurnOnCollection
                  reasons={collection.reasons}
                  then="Gates are then sampled as they pause, within the call and spend caps under Settings."
                />
              )}
            </EmptyState>
          </Section>
          <ReportDetails hint="Definitions, baselines and methods, and the census, spend and integrity checks — all empty until a gate is captured.">
            <ReportBody report={report} />
          </ReportDetails>
        </>
      ) : (
        <ReportBody report={report} />
      )}

      <AsOf>
        H1 report as of ledger record {report.asOf.seq} ({report.asOf.at ?? "no records"}). Opening
        this page never starts collection or calls a model.
      </AsOf>
    </>
  );
}

/** Everything in the report below its collection state. */
function ReportBody({ report }: { report: H1Report }) {
  return (
    <>
      <DefinitionsSection definitions={report.definitions} />

      <div className="grid gap-x-6 xl:grid-cols-2">
        <PendingSection pending={report.pending} excluded={report.gates.excluded} />
        <SpendSection spend={report.spend} />
      </div>

      {/* A census of nothing captured is thirty zero tiles; H2 says it in one
          line, and so does this. */}
      <Section title="Census">
        {report.census.every((c) => c.captured === 0) ? (
          <EmptyRow>No census recorded</EmptyRow>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {report.census.map((c) => (
              <CensusCard key={c.population} c={c} />
            ))}
          </div>
        )}
      </Section>

      <BaselineSection
        title="Deterministic baseline"
        empty={report.deterministic.length === 0 ? "No deterministic baseline rows" : null}
        caption="A rule result, not a probability."
      >
        {report.deterministic.map((row) => (
          <BaselineRow key={`${row.population}:${row.definition.digest}`} row={row} />
        ))}
      </BaselineSection>

      <BaselineSection
        title="Verdict baseline"
        empty={report.verdict.length === 0 ? "No verdict baseline rows" : null}
        caption="Verdict scores are ratings; no Brier score or calibration is computed for them."
      >
        {report.verdict.map((row) => (
          <VerdictRow key={`${row.population}:${row.definition.digest}`} row={row} />
        ))}
      </BaselineSection>

      <Section title="Model populations">
        {report.models.length === 0 ? (
          <EmptyState compact icon="inbox" title="No settled model assessments yet">
            A model row appears once collection is on and a sampled gate is settled by its operator,
            with its review state held from capture to decision.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            {report.models.map((p) => (
              <ModelCard
                key={JSON.stringify([
                  p.population,
                  p.question.id,
                  p.question.version,
                  p.question.digest,
                  p.projection.digest,
                  p.provider,
                ])}
                p={p}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Integrity">
        <IntegrityCard
          integrity={report.integrity}
          empty="No findings recorded"
          facts={[
            ["History (ledger, journal and joins)", report.integrity.history],
            ["Journal gaps", String(report.integrity.journal.gaps)],
          ]}
        />
      </Section>

      <Section title="Methods">
        <MethodsPanel methods={report.methods} />
      </Section>
    </>
  );
}

// ── Section ─────────────────────────────────────────────────────────────────

/** The server answered, with something that is not a report. */
export function NoReport({ name }: { name: string }) {
  return (
    <EmptyState icon="file" title={`No ${name} report available`}>
      The server answered, but not with a report this page can read.
    </EmptyState>
  );
}

export function DecisionH1Section() {
  const { data, loading, error, refresh } = useDecisionH1();

  return (
    <section aria-labelledby="decision-h1-title">
      <ExperimentHeader id="decision-h1-title" icon="approve" title="H1 — gate operator action">
        Predicts whether the operator will send a phase attempt back at its gate, and compares that
        with what the operator then did.
      </ExperimentHeader>
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Experiments"
            message={loadError("the H1 report", error)}
            action={
              <Button size="sm" icon="retry" onClick={refresh}>
                Retry
              </Button>
            }
          />
        </div>
      )}
      <Handoff busy={loading && !data} label="H1 report" skeleton={<SkeletonRows count={4} />}>
        {data ? <Report data={data} /> : !error && <NoReport name="H1" />}
      </Handoff>
    </section>
  );
}
