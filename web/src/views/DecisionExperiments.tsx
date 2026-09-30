import type { ReactNode } from "react";
import type {
  H2CensusTable,
  H2CollectionStatus,
  H2Distribution,
  H2Finding,
  H2Measured,
  H2PopulationBase,
  H2ProbePopulation,
  H2Proportion,
  H2Report,
  H2ResidualPopulation,
  H2Usage,
} from "@argus/contracts";
import { useDecisionExperiments } from "../useDecisionExperiments";
import { DecisionH1Section } from "./DecisionH1";
import { AlertStrip, Card, EmptyState, Handoff, Page, Section, SkeletonRows } from "../ds";

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

/** Populations are distinct per question digest, projection and full provider identity. */
const populationKey = (p: H2PopulationBase): string =>
  JSON.stringify([
    p.question.id,
    p.question.version,
    p.question.digest,
    p.projection.digest,
    p.provider,
  ]);

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
    <h3 className="mb-2 mt-5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
      {children}
    </h3>
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

function Notice() {
  return (
    <div
      role="note"
      className="mb-8 rounded-panel border border-eye/40 bg-surface px-5 py-4 text-sm leading-relaxed text-ink"
    >
      <p className="font-semibold">Shadow measurement only.</p>
      <p className="mt-1 text-ink-dim">
        These assessments are never read by any route, gate, retry or approval, and nothing here
        authorises an approval. Probe results measure recovery of an observed fact; they are not
        residual-cause accuracy. Residual-cause accuracy is unmeasured until valid reference labels
        exist.
      </p>
    </div>
  );
}

// ── Collection ──────────────────────────────────────────────────────────────

function CollectionSection({
  status,
  collection,
}: {
  status: H2CollectionStatus;
  collection: H2Report["collection"];
}) {
  const s = status.settings;
  const w = status.watcher;
  return (
    <Section title="Collection">
      <Card>
        <Facts
          rows={[
            ["Collection", status.enabled ? "Enabled" : "Off"],
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
              ["Residual sampling rate", rate(s.residualRate)],
              ["Probe sampling rate", rate(s.probeRate)],
              ["Max calls per 24h", String(s.maxCallsPer24h)],
              ["Min interval between calls", `${+(s.minCallIntervalMs / 60_000).toFixed(2)} min`],
              ["Max spend per 24h", `$${s.maxUsdPer24h}`],
              ["Requested model", s.requestedModel ?? "runner default"],
              ["Seed", <span className="font-mono">{s.seed}</span>],
            ]}
          />
        ) : (
          <p className="text-sm text-ink-faint">No valid settings.</p>
        )}
      </Card>

      <Heading>Collection configs</Heading>
      {collection.configs.length === 0 ? (
        <p className="text-sm text-ink-faint">No collection config recorded.</p>
      ) : (
        <div className="grid gap-2">
          {collection.configs.map((c) => (
            <Card key={c.digest}>
              <Facts
                rows={[
                  ["Digest", <span className="font-mono">{c.digest.slice(0, 12)}</span>],
                  ["First recorded", c.firstAt],
                  [
                    "Sampling rates",
                    c.rates.map((r) => `${r.id}@${r.version}: ${rate(r.rate)}`).join(" · "),
                  ],
                  [
                    "Provider",
                    `${c.provider.provider} · requested ${c.provider.requestedModel ?? "default"} · adapter v${c.provider.adapterVersion}`,
                  ],
                  ["Census records", String(c.census)],
                  ["Attempts", String(c.attempts)],
                ]}
              />
            </Card>
          ))}
        </div>
      )}
    </Section>
  );
}

// ── Population ──────────────────────────────────────────────────────────────

function CensusCard({ table }: { table: H2CensusTable }) {
  const excluded = Object.entries(table.excluded);
  const name = `${table.role} ${table.question.id}@${table.question.version}`;
  return (
    <Card>
      <h3 className="text-sm font-semibold text-ink">{name}</h3>
      <p className="mt-1 text-sm text-ink-dim">Runs considered: {table.considered}</p>
      <Heading>Excluded</Heading>
      {excluded.length === 0 ? (
        <p className="text-sm text-ink-faint">Nothing excluded.</p>
      ) : (
        <ul className="space-y-0.5 text-sm text-ink">
          {excluded.map(([reason, n]) => (
            <li key={reason}>
              {reason} → {n}
            </li>
          ))}
        </ul>
      )}
      <Heading>Strata</Heading>
      <DataTable
        caption={`Strata for ${name}`}
        head={
          <>
            <Th left>Stratum</Th>
            <Th>Eligible</Th>
            <Th>Selected</Th>
            <Th>Not selected</Th>
            <Th>Assessed</Th>
            <Th>Lost</Th>
            <Th>Construction error</Th>
            <Th>Expired</Th>
            <Th>Abandoned</Th>
            <Th>Pending</Th>
          </>
        }
      >
        {table.strata.map((s) => (
          <tr key={s.stratum}>
            <td className={TD_LEFT}>{s.stratum}</td>
            <td className={TD}>{s.eligible}</td>
            <td className={TD}>{s.selected}</td>
            <td className={TD}>{s.notSelected}</td>
            <td className={TD}>{s.assessed}</td>
            <td className={TD}>{s.lost}</td>
            <td className={TD}>{s.constructionError}</td>
            <td className={TD}>{s.expired}</td>
            <td className={TD}>{s.abandoned}</td>
            <td className={TD}>{s.pending}</td>
          </tr>
        ))}
      </DataTable>
    </Card>
  );
}

// ── Populations (shared header, counts, usage) ──────────────────────────────

function PopulationHeader({ p }: { p: H2PopulationBase }) {
  return (
    <>
      <h3 className="text-sm font-semibold text-ink">
        {p.question.id}@{p.question.version}
      </h3>
      <div className="mt-3">
        <Facts
          rows={[
            ["Definition", p.question.definition],
            ["Projection", `${p.projection.id}@${p.projection.version}`],
            ["Provider", p.provider.provider],
            ["Requested model", p.provider.requestedModel ?? "default"],
            ["Reported model", p.provider.reportedModel ?? "not reported"],
            ["Adapter version", String(p.provider.adapterVersion)],
            ["Elicitation", p.provider.elicitation],
          ]}
        />
      </div>
    </>
  );
}

function PopulationCounts({ p }: { p: H2PopulationBase }) {
  return (
    <>
      <Heading>Counts</Heading>
      <Facts
        rows={[
          ["Attempts by class", <Counts counts={p.attempts} />],
          ["Assessed", String(p.assessed)],
          ["Answered", String(p.answered)],
          ["Abstained", String(p.abstained)],
          ["Failed", String(p.failed)],
          ["Refusals (no provider call)", <Counts counts={p.refusals} />],
        ]}
      />
    </>
  );
}

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

function ProbeCard({ p }: { p: H2ProbePopulation }) {
  const name = `${p.question.id}@${p.question.version}`;
  const minBucket = p.reliability.minBucket;
  return (
    <Card>
      <PopulationHeader p={p} />
      <PopulationCounts p={p} />
      <Facts
        rows={[
          ["Reference-bearing", String(p.reference.bearing)],
          ["Reference-excluded", <Counts counts={p.reference.excluded} />],
        ]}
      />

      <Heading>Metrics</Heading>
      <Facts
        rows={[
          ["Accuracy (answered only)", formatProportion(p.accuracyAnswered)],
          ["Coverage (answered / assessed with a valid reference)", formatProportion(p.coverage)],
          [
            "Accuracy (end-to-end: abstain/fail count as wrong)",
            formatProportion(p.accuracyEndToEnd),
          ],
          ["Macro recall (answered)", formatNullable(p.macroRecall.answered, (v) => pct(v))],
          ["Macro recall (end-to-end)", formatNullable(p.macroRecall.endToEnd, (v) => pct(v))],
          [
            "Majority-class share — accuracy near this is no better than always guessing it",
            formatNullable(p.majorityClassShare, (v) => pct(v)),
          ],
          ["Ties", String(p.ties)],
          ["Cohen's κ (answered)", formatMeasured(p.kappa, (v) => v.toFixed(3))],
          [
            "Brier (multiclass, 0–2)",
            formatMeasured(p.brier, (v) => `${v.value.toFixed(3)} (n = ${v.n})`),
          ],
          ["ECE", formatMeasured(p.ece, (v) => `${v.value.toFixed(3)} (n = ${v.n})`)],
        ]}
      />

      <Heading>Per-class results</Heading>
      <DataTable
        caption={`Per-class results for ${name}`}
        head={
          <>
            <Th left>Reference label</Th>
            <Th>n</Th>
            <Th>Answered</Th>
            <Th>Abstained</Th>
            <Th>Failed</Th>
            <Th>Correct</Th>
            <Th>Recall (answered)</Th>
            <Th>Recall (end-to-end)</Th>
          </>
        }
      >
        {p.classes.map((c) => (
          <tr key={c.label}>
            <td className={TD_LEFT}>{c.label}</td>
            <td className={TD}>{c.n}</td>
            <td className={TD}>{c.answered}</td>
            <td className={TD}>{c.abstained}</td>
            <td className={TD}>{c.failed}</td>
            <td className={TD}>{c.correct}</td>
            <td className={TD}>{formatProportion(c.recallAnswered)}</td>
            <td className={TD}>{formatProportion(c.recallEndToEnd)}</td>
          </tr>
        ))}
      </DataTable>

      <Heading>Confusion matrix (rows: reference label, columns: answer)</Heading>
      <DataTable
        caption={`Confusion matrix for ${name}`}
        head={
          <>
            <Th left>Reference \ answer</Th>
            {p.confusion.columns.map((col) => (
              <Th key={col}>{col}</Th>
            ))}
          </>
        }
      >
        {p.confusion.rows.map((row, i) => (
          <tr key={row}>
            <th scope="row" className={`${TD_LEFT} font-normal`}>
              {row}
            </th>
            {p.confusion.columns.map((col, j) => (
              <td key={col} className={TD}>
                {p.confusion.counts[i][j]}
              </td>
            ))}
          </tr>
        ))}
      </DataTable>

      <Heading>Reliability (confidence buckets)</Heading>
      <DataTable
        caption={`Reliability buckets for ${name}`}
        head={
          <>
            <Th left>Confidence bucket</Th>
            <Th>n</Th>
            <Th>Status</Th>
            <Th>Mean confidence</Th>
            <Th>Accuracy</Th>
          </>
        }
      >
        {p.reliability.buckets.map((b) => (
          <tr key={b.lower}>
            <td className={TD_LEFT}>
              {b.lower}–{b.upper}
            </td>
            <td className={TD}>{b.n}</td>
            <td className={TD}>{b.status}</td>
            {b.status === "measured" ? (
              <>
                <td className={TD}>{formatNullable(b.meanConfidence, (v) => v.toFixed(3))}</td>
                <td className={TD}>{formatNullable(b.accuracy, (v) => pct(v))}</td>
              </>
            ) : (
              <td colSpan={2} className={`${TD} text-ink-faint`}>
                unmeasured (n &lt; {minBucket})
              </td>
            )}
          </tr>
        ))}
      </DataTable>

      <UsageFacts usage={p.usage} />
    </Card>
  );
}

function ResidualCard({ p }: { p: H2ResidualPopulation }) {
  const name = `${p.question.id}@${p.question.version}`;
  const topAnswers = Object.entries(p.topAnswers);
  return (
    <Card>
      <PopulationHeader p={p} />
      <PopulationCounts p={p} />

      <Heading>Accuracy and probability</Heading>
      <div className="space-y-1 rounded-lg border border-line px-4 py-3 text-sm font-semibold text-ink">
        <p>Accuracy: Unmeasured — {p.accuracy.reason}</p>
        <p>Probability: Unmeasured — {p.probability.reason}</p>
      </div>

      <Heading>Strata</Heading>
      <DataTable
        caption={`Strata for ${name}`}
        head={
          <>
            <Th left>Stratum</Th>
            <Th>Assessed</Th>
            <Th>Answered</Th>
            <Th>Abstained</Th>
            <Th>Failed</Th>
          </>
        }
      >
        {p.strata.map((s) => (
          <tr key={s.stratum}>
            <td className={TD_LEFT}>{s.stratum}</td>
            <td className={TD}>{s.assessed}</td>
            <td className={TD}>{s.answered}</td>
            <td className={TD}>{s.abstained}</td>
            <td className={TD}>{s.failed}</td>
          </tr>
        ))}
      </DataTable>

      <Heading>Top-answer counts (descriptive — not accuracy)</Heading>
      {topAnswers.length === 0 ? (
        <p className="text-sm text-ink-faint">No answers recorded.</p>
      ) : (
        <ul className="space-y-0.5 text-sm text-ink">
          {topAnswers.map(([answer, n]) => (
            <li key={answer}>
              {answer}: {n}
            </li>
          ))}
        </ul>
      )}

      <UsageFacts usage={p.usage} />
    </Card>
  );
}

// ── Baselines, integrity, methods ───────────────────────────────────────────

function FindingList({ findings }: { findings: H2Finding[] }) {
  if (findings.length === 0) return <p className="text-sm text-ink-faint">No findings.</p>;
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

function IntegritySection({ report }: { report: H2Report }) {
  const { integrity } = report;
  return (
    <Section title="Integrity">
      <Card>
        <Facts
          rows={[
            ["History (ledger, journal and joins)", integrity.history],
            ["Journal gaps", String(integrity.journal.gaps)],
            ["Journal assessments outside the experiment", String(report.outsideExperiment)],
          ]}
        />
        <Heading>Ledger findings</Heading>
        <FindingList findings={integrity.ledger} />
        <Heading>Journal notices</Heading>
        {integrity.journal.notices.length === 0 ? (
          <p className="text-sm text-ink-faint">No findings.</p>
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

// ── Page ────────────────────────────────────────────────────────────────────

export default function DecisionExperiments() {
  const { data, loading, error } = useDecisionExperiments();

  return (
    <Page title="Decision experiments">
      <Notice />
      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't load the H2 report: ${error}`} />
        </div>
      )}
      <Handoff busy={loading && !data} label="H2 report" skeleton={<SkeletonRows count={4} />}>
        {data ? <Report data={data} /> : !error && <EmptyState>No report available.</EmptyState>}
      </Handoff>
      <DecisionH1Section />
    </Page>
  );
}

function Report({
  data,
}: {
  data: NonNullable<ReturnType<typeof useDecisionExperiments>["data"]>;
}) {
  const { collection, report } = data;
  const noAssessments = report.probe.length === 0 && report.residual.length === 0;
  return (
    <>
      <CollectionSection status={collection} collection={report.collection} />

      <Section title="Population">
        {report.census.length === 0 ? (
          <p className="text-sm text-ink-faint">No census recorded.</p>
        ) : (
          <div className="grid gap-3">
            {report.census.map((t) => (
              <CensusCard key={`${t.role}:${t.question.id}@${t.question.version}`} table={t} />
            ))}
          </div>
        )}
      </Section>

      {noAssessments ? (
        <div className="mb-8">
          <EmptyState>No shadow assessments recorded.</EmptyState>
        </div>
      ) : (
        <>
          {report.probe.length > 0 && (
            <Section title="Probe: run.termination-probe">
              <div className="grid gap-3">
                {report.probe.map((p) => (
                  <ProbeCard key={populationKey(p)} p={p} />
                ))}
              </div>
            </Section>
          )}
          {report.residual.length > 0 && (
            <Section title="Residual: run.failure-cause.residual">
              <div className="grid gap-3">
                {report.residual.map((p) => (
                  <ResidualCard key={populationKey(p)} p={p} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      <Section title="Baselines">
        {report.baselines.length === 0 ? (
          <p className="text-sm text-ink-faint">No baselines.</p>
        ) : (
          <ul className="space-y-1 text-sm text-ink">
            {report.baselines.map((b) => (
              <li key={b.provider}>
                {b.provider} — {b.status} — {b.reason}
              </li>
            ))}
          </ul>
        )}
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
        As of ledger record {report.asOf.seq} ({report.asOf.at ?? "no records"}). Opening this page
        never starts collection or calls a model.
      </p>
    </>
  );
}
