import type { ReactNode } from "react";
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
  H2Measured,
  H2Proportion,
  H2Usage,
} from "@argus/contracts";
import { useDecisionH1 } from "../useDecisionH1";
import { AlertStrip, Card, EmptyState, Handoff, Section, SkeletonRows } from "../ds";

// ── Formatting ──────────────────────────────────────────────────────────────

/** 0.625 → "62.5%". */
function pct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/** A configured rate: no padding zeros, so 0.05 reads "5%" rather than "5.0%". */
function rate(v: number): string {
  return `${+(v * 100).toFixed(2)}%`;
}

/** "62.5% (5/8, 95% CI 30.6–86.3%)", or "— (n = 0)" when there is nothing to divide. */
function formatProportion(p: H2Proportion): string {
  if (p.value === null) return "— (n = 0)";
  const ci = p.ci95
    ? `, 95% CI ${(p.ci95[0] * 100).toFixed(1)}–${(p.ci95[1] * 100).toFixed(1)}%`
    : "";
  return `${pct(p.value)} (${p.k}/${p.n}${ci})`;
}

function formatMeasured<T>(m: H2Measured<T>, show: (v: T) => string): string {
  return m.status === "measured" ? show(m.value) : `unmeasured — ${m.reason}`;
}

const formatNullable = (v: number | null, show: (n: number) => string): string =>
  v === null ? "—" : show(v);

const formatDistribution = (d: H2Distribution, unit: string): string =>
  d.n === 0
    ? "— (n = 0)"
    : `p50 ${d.p50 ?? "—"} · p95 ${d.p95 ?? "—"}${d.max !== null ? ` · max ${d.max}` : ""} ${unit} (n = ${d.n})`;

const formatUsdAmount = (v: number): string => `$${v.toFixed(4)}`;

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

// ── Small presentational pieces ─────────────────────────────────────────────

const TH = "pb-2 pr-3 text-right font-normal";
const TH_LEFT = "pb-2 pr-3 text-left font-normal";
const TD = "py-1.5 pr-3 text-right font-mono tabular-nums text-ink";
const TD_LEFT = "py-1.5 pr-3 text-left text-ink";

function DataTable({
  caption,
  head,
  children,
}: {
  caption: string;
  head: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            {head}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

function Th({ children, left = false }: { children: ReactNode; left?: boolean }) {
  return (
    <th scope="col" className={left ? TH_LEFT : TH}>
      {children}
    </th>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-2 mt-5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
      {children}
    </h4>
  );
}

/** Label/value rows. Plain ink throughout: no metric here is a pass/fail signal. */
function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-faint">{label}</dt>
          <dd className="break-words text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Counts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return <>none</>;
  return <>{entries.map(([k, v]) => `${k}: ${v}`).join(" · ")}</>;
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-xs text-ink-faint">{children}</p>;
}

function Notice({ statement }: { statement: string }) {
  return (
    <div
      role="note"
      className="mb-6 rounded-panel border border-eye/40 bg-surface px-5 py-4 text-sm leading-relaxed text-ink"
    >
      <p className="font-semibold">{statement}</p>
      <p className="mt-1 text-ink-dim">
        H1 is a shadow experiment: no gate, badge, ordering or approval reads these predictions, and
        gates still waiting on an operator are shown only as counts.
      </p>
    </div>
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
      <Card>
        <Facts
          rows={[
            ["H1 collection", status.enabled ? "Collection enabled" : "Collection off"],
            [
              "Watcher",
              `${w.state}${w.detail ? ` — ${w.detail}` : ""}${w.until ? ` (until ${w.until})` : ""}`,
            ],
            ["First collection", collection.start ?? "none recorded"],
          ]}
        />
        {!status.enabled && (
          <>
            <Heading>Reasons collection is off</Heading>
            {status.reasons.length === 0 ? (
              <p className="text-sm text-ink-faint">No reason reported.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
                {status.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </>
        )}
        <Heading>Settings</Heading>
        {s ? (
          <Facts
            rows={[
              ["Sampling rate", rate(s.rate)],
              ["Seed", <span className="font-mono">{s.seed}</span>],
              [
                "Models",
                s.models.length === 0
                  ? "none"
                  : s.models.map((m) => m ?? "runner default").join(" · "),
              ],
              ["Combined max calls per 24h", String(s.maxCallsPer24h)],
              ["H1 own share per 24h", String(s.maxOwnCallsPer24h)],
              ["Min interval between calls", `${+(s.minCallIntervalMs / 60_000).toFixed(2)} min`],
              ["Max spend per 24h", `$${s.maxUsdPer24h}`],
            ]}
          />
        ) : (
          <p className="text-sm text-ink-faint">No settings reported.</p>
        )}
      </Card>

      <Heading>Collection configs</Heading>
      {collection.configs.length === 0 ? (
        <p className="text-sm text-ink-faint">No H1 collection config recorded.</p>
      ) : (
        <div className="grid gap-2">
          {collection.configs.map((c) => (
            <Card key={c.digest}>
              <Facts
                rows={[
                  ["Digest", <span className="font-mono">{c.digest.slice(0, 12)}</span>],
                  ["First recorded", c.firstAt],
                  ["Recorded sampling rate", rate(c.rate)],
                  [
                    "Arms (requested model)",
                    c.arms.length === 0
                      ? "none"
                      : c.arms.map((a) => a.requestedModel ?? "runner default").join(" · "),
                  ],
                ]}
              />
            </Card>
          ))}
        </div>
      )}
    </Section>
  );
}

// ── Pending ─────────────────────────────────────────────────────────────────

function PendingSection({ pending }: { pending: H1Report["pending"] }) {
  const populations = Object.entries(pending.byPopulation) as Array<[H1Population, number]>;
  return (
    <Section title="Pending gates">
      <Card>
        <Facts
          rows={[
            ["Pending gates (total)", String(pending.total)],
            ...populations.map(([p, n]): [string, ReactNode] => [populationLabel(p), String(n)]),
          ]}
        />
        <Caption>
          Pending gates are counted, not shown: no pending gate, prediction or label is listed here.
        </Caption>
      </Card>
    </Section>
  );
}

// ── Census ──────────────────────────────────────────────────────────────────

function CensusCard({ c }: { c: H1Census }) {
  return (
    <Card>
      <h3 className="text-sm font-semibold text-ink">{populationLabel(c.population)}</h3>
      <div className="mt-3">
        <Facts
          rows={[
            ["Captured", String(c.captured)],
            ["Sampled", String(c.sampled)],
            ["Not sampled", String(c.notSampled)],
            ["Pending", String(c.pending)],
            ["Resolved", String(c.resolved)],
            ["Window closed", String(c.windowClosed)],
            ["Labeled: sent back", String(c.labeled.sentBack)],
            ["Labeled: not sent back", String(c.labeled.notSentBack)],
            ["Labeled: approve", String(c.labeled.approve)],
            ["Labeled: revise", String(c.labeled.revise)],
            ["Labeled: abort", String(c.labeled.abort)],
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
      </div>
    </Card>
  );
}

// ── Agreement ───────────────────────────────────────────────────────────────

function Agreement({ a, name }: { a: H1Agreement; name: string }) {
  return (
    <>
      <DataTable
        caption={`Confusion matrix for ${name}`}
        head={
          <>
            <Th left>Operator \ predicted</Th>
            {a.confusion.columns.map((col) => (
              <Th key={col}>{col}</Th>
            ))}
          </>
        }
      >
        {a.confusion.rows.map((row, i) => (
          <tr key={row}>
            <th scope="row" className={`${TD_LEFT} font-normal`}>
              {referenceLabel(row)}
            </th>
            {a.confusion.columns.map((col, j) => (
              <td key={col} className={TD}>
                {a.confusion.counts[i]?.[j] ?? 0}
              </td>
            ))}
          </tr>
        ))}
      </DataTable>
      <div className="mt-3">
        <Facts
          rows={[
            ["Scored", String(a.scored)],
            ["Answered", String(a.answered)],
            ["Coverage", formatProportion(a.coverage)],
            ["Agreement with operator (answered)", formatProportion(a.agreementAnswered)],
            ["Agreement with operator (end-to-end)", formatProportion(a.agreementEndToEnd)],
            ["False close (predicts approve | sent back)", formatProportion(a.falseClose)],
            [
              "False escalation (predicts sent back | approved)",
              formatProportion(a.falseEscalation),
            ],
            ["Cohen's κ", formatMeasured(a.kappa, (v) => v.toFixed(3))],
          ]}
        />
      </div>
    </>
  );
}

// ── Baselines ───────────────────────────────────────────────────────────────

function BaselineRow({ row, children }: { row: H1BaselineRow; children?: ReactNode }) {
  const name = `${row.definition.id}@${row.definition.version}`;
  return (
    <Card>
      <h3 className="text-sm font-semibold text-ink">{populationLabel(row.population)}</h3>
      <div className="mt-3">
        <Facts
          rows={[
            ["Definition", name],
            ["Scored", String(row.scored)],
          ]}
        />
      </div>
      {children}
      <Heading>Agreement</Heading>
      <Agreement a={row.agreement} name={`${name} (${populationLabel(row.population)})`} />
    </Card>
  );
}

function VerdictRow({ row }: { row: H1VerdictRow }) {
  return (
    <BaselineRow row={row}>
      <div className="mt-1.5">
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

// ── Models ──────────────────────────────────────────────────────────────────

function UsageFacts({ usage }: { usage: H2Usage }) {
  return (
    <>
      <Heading>Usage</Heading>
      <Facts
        rows={[
          ["Latency", formatDistribution(usage.latencyMs, "ms")],
          ["Cost (USD)", formatTotals(usage.costUsd, formatUsdAmount)],
          ["Tokens", formatTotals(usage.tokens, (n) => String(Math.round(n * 10) / 10))],
          ["Snapshot size", formatDistribution(usage.snapshotBytes, "bytes")],
        ]}
      />
    </>
  );
}

function ModelCard({ p }: { p: H1ModelPopulation }) {
  const question = `${p.question.id}@${p.question.version}`;
  const name = `${question} (${populationLabel(p.population)})`;
  return (
    <Card>
      <h3 className="text-sm font-semibold text-ink">{populationLabel(p.population)}</h3>
      <p className="mt-0.5 font-mono text-xs text-ink-dim">{question}</p>
      <div className="mt-3">
        <Facts
          rows={[
            ["Definition", p.question.definition],
            ["Projection", `${p.projection.id}@${p.projection.version}`],
            ["Provider", p.provider.provider],
            ["Requested model", p.provider.requestedModel ?? "runner default"],
            ["Reported model", p.provider.reportedModel ?? "not reported"],
            ["Adapter version", String(p.provider.adapterVersion)],
            ["Elicitation", p.provider.elicitation],
          ]}
        />
      </div>

      <Heading>Counts</Heading>
      <Facts
        rows={[
          ["Attempts by class", <Counts counts={p.attempts} />],
          ["Assessed", String(p.assessed)],
          ["Answered", String(p.answered)],
          ["Abstained", String(p.abstained)],
          ["Failed", String(p.failed)],
          ["Refusals (no provider call)", <Counts counts={p.refusals} />],
          ["Excluded from scoring", <Counts counts={p.excluded} />],
        ]}
      />

      <Heading>Agreement</Heading>
      <Agreement a={p.agreement} name={name} />

      <Heading>Calibration</Heading>
      <Facts
        rows={[
          ["Brier", formatMeasured(p.brier, (v) => `${v.value.toFixed(3)} (n = ${v.n})`)],
          ["ECE", formatMeasured(p.ece, (v) => `${v.value.toFixed(3)} (n = ${v.n})`)],
        ]}
      />
      <Heading>Reliability (predicted probability of sent back)</Heading>
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
                unmeasured (n = {b.n})
              </td>
            )}
          </tr>
        ))}
      </DataTable>

      <Heading>Deterministic baseline on the same items</Heading>
      <Agreement a={p.paired.deterministic} name={`${name}, deterministic baseline`} />
      <Heading>Verdict baseline on the same items</Heading>
      <Agreement a={p.paired.verdict} name={`${name}, verdict baseline`} />

      <UsageFacts usage={p.usage} />
    </Card>
  );
}

// ── Integrity ───────────────────────────────────────────────────────────────

function FindingList({ findings }: { findings: H2Finding[] }) {
  if (findings.length === 0) return <p className="text-sm text-ink-faint">No findings recorded.</p>;
  return (
    <ul className="space-y-2 text-sm text-ink">
      {findings.map((f, i) => (
        <li key={i} className="rounded-lg border border-line px-3 py-2">
          <span className="font-mono text-xs text-ink-dim">
            {f.kind}
            {f.line !== null ? ` · line ${f.line}` : ""}
            {f.attemptId ? ` · ${f.attemptId}` : ""}
          </span>
          <p className="mt-0.5">{f.detail}</p>
        </li>
      ))}
    </ul>
  );
}

function IntegritySection({ report }: { report: H1Report }) {
  const { integrity } = report;
  return (
    <Section title="Integrity">
      <Card>
        <Facts
          rows={[
            ["History (ledger, journal and joins)", integrity.history],
            ["Journal gaps", String(integrity.journal.gaps)],
          ]}
        />
        <Heading>Ledger findings</Heading>
        <FindingList findings={integrity.ledger} />
        <Heading>Journal notices</Heading>
        {integrity.journal.notices.length === 0 ? (
          <p className="text-sm text-ink-faint">No findings recorded.</p>
        ) : (
          <ul className="space-y-2 text-sm text-ink">
            {integrity.journal.notices.map((n, i) => (
              <li key={i} className="rounded-lg border border-line px-3 py-2">
                <span className="font-mono text-xs text-ink-dim">
                  {n.kind}
                  {n.segment ? ` · ${n.segment}` : ""}
                  {n.line !== null ? ` · line ${n.line}` : ""}
                </span>
                <p className="mt-0.5">{n.detail}</p>
              </li>
            ))}
          </ul>
        )}
        <Heading>Findings</Heading>
        <FindingList findings={integrity.findings} />
      </Card>
    </Section>
  );
}

// ── Report ──────────────────────────────────────────────────────────────────

function Report({ data }: { data: NonNullable<ReturnType<typeof useDecisionH1>["data"]> }) {
  const { collection, report } = data;
  return (
    <>
      <Notice statement={report.statement} />

      <CollectionSection status={collection} collection={report.collection} />
      <PendingSection pending={report.pending} />

      <Section title="Census">
        {report.census.length === 0 ? (
          <p className="text-sm text-ink-faint">No H1 census recorded.</p>
        ) : (
          <div className="grid gap-3">
            {report.census.map((c) => (
              <CensusCard key={c.population} c={c} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Gate exclusions">
        <Card>
          <p className="text-sm text-ink">
            Gate pauses seen and not captured: <Counts counts={report.gates.excluded} />
          </p>
        </Card>
      </Section>

      <Section title="Deterministic baseline">
        {report.deterministic.length === 0 ? (
          <p className="text-sm text-ink-faint">No deterministic baseline rows.</p>
        ) : (
          <div className="grid gap-3">
            {report.deterministic.map((row) => (
              <BaselineRow key={`${row.population}:${row.definition.digest}`} row={row} />
            ))}
          </div>
        )}
        <Caption>A rule result, not a probability.</Caption>
      </Section>

      <Section title="Verdict baseline">
        {report.verdict.length === 0 ? (
          <p className="text-sm text-ink-faint">No verdict baseline rows.</p>
        ) : (
          <div className="grid gap-3">
            {report.verdict.map((row) => (
              <VerdictRow key={`${row.population}:${row.definition.digest}`} row={row} />
            ))}
          </div>
        )}
        <Caption>
          Verdict scores are ratings; no Brier score or calibration is computed for them.
        </Caption>
      </Section>

      <Section title="Model populations">
        {report.models.length === 0 ? (
          <div className="mb-2">
            <EmptyState>No settled model assessments yet.</EmptyState>
          </div>
        ) : (
          <div className="grid gap-3">
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

      <Section title="Spend">
        <Card>
          <Facts
            rows={[
              ["Attempts", String(report.spend.attempts)],
              ["Spent", String(report.spend.spent)],
              ["Total (USD)", `$${report.spend.usdTotal.toFixed(4)}`],
              ["Unknown cost", String(report.spend.usdUnknown)],
            ]}
          />
          <Caption>Counts and money across all attempts, settled or not; never outcomes.</Caption>
        </Card>
      </Section>

      <IntegritySection report={report} />

      <Section title="Methods">
        <dl className="grid gap-3 text-sm">
          {Object.entries(report.methods).map(([key, text]) => (
            <div key={key}>
              <dt className="font-mono text-xs text-ink-dim">{key}</dt>
              <dd className="mt-0.5 text-ink">{text}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <p className="text-xs text-ink-faint">
        H1 report as of ledger record {report.asOf.seq} ({report.asOf.at ?? "no records"}). Opening
        this page never starts collection or calls a model.
      </p>
    </>
  );
}

// ── Section ─────────────────────────────────────────────────────────────────

export function DecisionH1Section() {
  const { data, loading, error } = useDecisionH1();

  return (
    <section aria-labelledby="decision-h1-title" className="mt-12 border-t border-line pt-8">
      <h2 id="decision-h1-title" className="mb-4 text-lg font-semibold text-ink">
        H1 — gate operator action
      </h2>
      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't load the H1 report: ${error}`} />
        </div>
      )}
      <Handoff busy={loading && !data} label="H1 report" skeleton={<SkeletonRows count={4} />}>
        {data ? <Report data={data} /> : !error && <EmptyState>No H1 report available.</EmptyState>}
      </Handoff>
    </section>
  );
}
