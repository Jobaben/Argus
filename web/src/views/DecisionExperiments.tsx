import type { ReactNode } from "react";
import type {
  H2CensusTable,
  H2QuestionRole,
  H2CollectionStatus,
  H2PopulationBase,
  H2ProbePopulation,
  H2Report,
  H2ResidualPopulation,
} from "@argus/contracts";
import { useDecisionExperiments } from "../useDecisionExperiments";
import {
  AsOf,
  Block,
  CardTitle,
  CollectionCard,
  ConfigWell,
  Counts,
  DataTable,
  DecisionH1Section,
  DefinitionStatus,
  EmptyLine,
  EmptyRow,
  ExperimentHeader,
  Facts,
  IntegrityCard,
  Matrix,
  MethodsPanel,
  NoReport,
  Notice,
  ProportionValue,
  ReportDetails,
  StatGrid,
  StatePill,
  SubHeading,
  TD,
  TD_LEFT,
  Th,
  TurnOnCollection,
  UsageFacts,
  WatcherValue,
} from "./DecisionH1";
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
  Page,
  Section,
  SkeletonRows,
  chipClass,
} from "../ds";
import { loadError } from "../live/loadError";

/** A census table's role, in the words of the section it feeds. */
const ROLE_LABEL: Record<H2QuestionRole, string> = {
  probe: "Probe question",
  residual: "Residual question",
};

// ── Formatting ──────────────────────────────────────────────────────────────

/** Populations are distinct per question digest, projection and full provider identity. */
const populationKey = (p: H2PopulationBase): string =>
  JSON.stringify([
    p.question.id,
    p.question.version,
    p.question.digest,
    p.projection.digest,
    p.provider,
  ]);

/** A machine value as a chip: an answer option, an exclusion reason. */
const MONO_CHIP =
  "inline-flex items-center rounded-md border border-line px-1.5 py-px font-mono text-micro text-ink-dim";

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
        settings={
          s
            ? [
                ["Residual sampling rate", rate(s.residualRate)],
                ["Probe sampling rate", rate(s.probeRate)],
                ["Requested model", s.requestedModel ?? RUNNER_DEFAULT],
                ["Max calls per 24h", String(s.maxCallsPer24h)],
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
                    [
                      "Sampling rates",
                      c.rates.map((r) => `${r.id}@${r.version}: ${rate(r.rate)}`).join(" · "),
                    ],
                    [
                      "Provider",
                      `${c.provider.provider} · requested ${c.provider.requestedModel ?? RUNNER_DEFAULT} · adapter v${c.provider.adapterVersion}`,
                    ],
                    ["Census records", String(c.census)],
                    ["Attempts", String(c.attempts)],
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

// ── Questions ───────────────────────────────────────────────────────────────

/**
 * The two questions as registered: what each may answer, and whether the
 * definition on disk is the one the report expects. Shown before any result so
 * a fresh install says what the experiment *would* measure, not only that it
 * has measured nothing.
 */
function QuestionsSection({ definitions }: { definitions: H2Report["definitions"] }) {
  if (definitions.length === 0) return null;
  return (
    <Section title="Questions">
      <ul className="divide-y divide-line rounded-tile border border-line bg-surface shadow-raised">
        {definitions.map((d) => (
          <li key={`${d.role}:${d.id}@${d.version}`} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className={`${chipClass()} w-16 justify-center`}>{d.role}</span>
              <span className="min-w-0 break-all font-mono text-small text-ink">
                {d.id}@{d.version}
              </span>
              <DefinitionStatus status={d.definition} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:pl-[4.75rem]">
              {d.projection && (
                <span className="mr-1.5 font-mono text-caption text-ink-faint">
                  sees {d.projection.id}@{d.projection.version}
                </span>
              )}
              {d.options.map((o) => (
                <span key={o} className={MONO_CHIP}>
                  {o}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ── Population ──────────────────────────────────────────────────────────────

function CensusCard({ table }: { table: H2CensusTable }) {
  const excluded = Object.entries(table.excluded);
  const name = `${table.role} ${table.question.id}@${table.question.version}`;
  return (
    <Card>
      <CardTitle
        id={`${table.question.id}@${table.question.version}`}
        aside={`Runs considered: ${table.considered}`}
      >
        {ROLE_LABEL[table.role] ?? table.role}
      </CardTitle>
      <Block title="Excluded">
        {excluded.length === 0 ? (
          <EmptyLine>Nothing excluded</EmptyLine>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {excluded.map(([reason, n]) => (
              <li key={reason} className={`${MONO_CHIP} gap-1.5`}>
                {reason}
                <span className="font-sans font-semibold text-ink">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </Block>
      <Block title="Strata">
        <DataTable
          caption={`Strata for ${name}`}
          minWidth="min-w-[44rem]"
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
              <td className={`${TD_LEFT} font-mono text-caption`}>{s.stratum}</td>
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
      </Block>
    </Card>
  );
}

// ── Populations (shared header, counts) ─────────────────────────────────────

function PopulationHeader({ p }: { p: H2PopulationBase }) {
  return (
    <>
      <CardTitle>
        <span className="break-all font-mono">
          {p.question.id}@{p.question.version}
        </span>
      </CardTitle>
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
    </>
  );
}

function PopulationCounts({
  p,
  extra = [],
  more = [],
}: {
  p: H2PopulationBase;
  /** Further counts, as tiles. */
  extra?: Array<[string, number]>;
  /** Further breakdowns, as rows. */
  more?: Array<[string, ReactNode]>;
}) {
  return (
    <Block title="Counts">
      <StatGrid
        cols={extra.length > 0 ? 5 : 4}
        items={[
          ["Assessed", p.assessed],
          ["Answered", p.answered],
          ["Abstained", p.abstained],
          ["Failed", p.failed],
          ...extra,
        ]}
      />
      <div className="mt-3">
        <Facts
          rows={[
            ["Attempts by class", <Counts counts={p.attempts} />],
            ["Refusals (no provider call)", <Counts counts={p.refusals} />],
            ...more,
          ]}
        />
      </div>
    </Block>
  );
}

function ProbeCard({ p }: { p: H2ProbePopulation }) {
  const name = `${p.question.id}@${p.question.version}`;
  const minBucket = p.reliability.minBucket;
  return (
    <Card>
      <PopulationHeader p={p} />
      <PopulationCounts
        p={p}
        extra={[["Reference-bearing", p.reference.bearing]]}
        more={[["Reference-excluded", <Counts counts={p.reference.excluded} />]]}
      />

      <Block title="Metrics">
        <Facts
          rows={[
            ["Accuracy (answered only)", <ProportionValue p={p.accuracyAnswered} />],
            [
              "Coverage (answered / assessed with a valid reference)",
              <ProportionValue p={p.coverage} />,
            ],
            [
              "Accuracy (end-to-end: abstain/fail count as wrong)",
              <ProportionValue p={p.accuracyEndToEnd} />,
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
      </Block>

      <Block title="Per-class results">
        <DataTable
          caption={`Per-class results for ${name}`}
          minWidth="min-w-[46rem]"
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
      </Block>

      <div className="mt-5 grid gap-x-8 gap-y-5 border-t border-line pt-4 xl:grid-cols-2">
        <div className="min-w-0">
          <SubHeading>Confusion matrix (rows: reference label, columns: answer)</SubHeading>
          <Matrix
            caption={`Confusion matrix for ${name}`}
            corner="Reference \ answer"
            columns={p.confusion.columns}
            rows={p.confusion.rows}
            counts={p.confusion.counts}
          />
        </div>
        <div className="min-w-0">
          <SubHeading>Reliability (confidence buckets)</SubHeading>
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
                <td className={`${TD} text-ink-dim`}>{b.status}</td>
                {b.status === "measured" ? (
                  <>
                    <td className={TD}>{formatNullable(b.meanConfidence, (v) => v.toFixed(3))}</td>
                    <td className={TD}>{formatNullable(b.accuracy, (v) => pct(v))}</td>
                  </>
                ) : (
                  <td colSpan={2} className={`${TD} text-ink-faint`}>
                    {unmeasuredBucket(b.n, minBucket)}
                  </td>
                )}
              </tr>
            ))}
          </DataTable>
        </div>
      </div>

      <UsageFacts usage={p.usage} />
    </Card>
  );
}

function ResidualCard({ p }: { p: H2ResidualPopulation }) {
  const name = `${p.question.id}@${p.question.version}`;
  const topAnswers = Object.entries(p.topAnswers).sort((a, b) => b[1] - a[1]);
  const most = Math.max(1, ...topAnswers.map(([, n]) => n));
  return (
    <Card>
      <PopulationHeader p={p} />
      <PopulationCounts p={p} />

      <Block title="Accuracy and probability">
        <dl className="flex flex-col gap-1.5 rounded-control bg-ground-2/70 px-3 py-2.5 text-small">
          <div className="flex flex-wrap gap-x-3">
            <dt className="w-24 shrink-0 text-ink-faint">Accuracy</dt>
            <dd className="font-semibold text-ink">Unmeasured — {p.accuracy.reason}</dd>
          </div>
          <div className="flex flex-wrap gap-x-3">
            <dt className="w-24 shrink-0 text-ink-faint">Probability</dt>
            <dd className="font-semibold text-ink">Unmeasured — {p.probability.reason}</dd>
          </div>
        </dl>
      </Block>

      <div className="mt-5 grid gap-x-8 gap-y-5 border-t border-line pt-4 xl:grid-cols-2">
        <div className="min-w-0">
          <SubHeading>Strata</SubHeading>
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
                <td className={`${TD_LEFT} font-mono text-caption`}>{s.stratum}</td>
                <td className={TD}>{s.assessed}</td>
                <td className={TD}>{s.answered}</td>
                <td className={TD}>{s.abstained}</td>
                <td className={TD}>{s.failed}</td>
              </tr>
            ))}
          </DataTable>
        </div>
        <div className="min-w-0">
          <SubHeading>Top-answer counts (descriptive — not accuracy)</SubHeading>
          {topAnswers.length === 0 ? (
            <EmptyLine>No answers recorded</EmptyLine>
          ) : (
            // Bars for share of answers given — a description of what the model
            // said, in neutral ink, never a score.
            <ul className="flex flex-col gap-2">
              {topAnswers.map(([answer, n]) => (
                <li
                  key={answer}
                  className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-center gap-3"
                >
                  <span className="truncate font-mono text-caption text-ink-dim">
                    {answer}: {n}
                  </span>
                  <span aria-hidden="true" className="h-1.5 rounded-full bg-ink-faint/15">
                    <span
                      className="block h-full rounded-full bg-ink-faint/60"
                      style={{ width: `${(n / most) * 100}%` }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <UsageFacts usage={p.usage} />
    </Card>
  );
}

// ── Baselines ───────────────────────────────────────────────────────────────

function BaselinesSection({ baselines }: { baselines: H2Report["baselines"] }) {
  return (
    <Section title="Baselines">
      {baselines.length === 0 ? (
        <EmptyRow>No baselines</EmptyRow>
      ) : (
        <ul className="divide-y divide-line rounded-tile border border-line bg-surface shadow-raised">
          {baselines.map((b) => (
            <li
              key={b.provider}
              className="flex flex-col gap-x-6 gap-y-1.5 px-4 py-3 sm:flex-row sm:items-baseline"
            >
              <span className="flex shrink-0 items-center gap-2 sm:w-64">
                <span className="text-small font-semibold text-ink">{b.provider}</span>
                <span className={chipClass()}>{b.status}</span>
              </span>
              <span className="min-w-0 max-w-3xl text-small text-ink-dim">{b.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function DecisionExperiments() {
  const { data, loading, error, refresh } = useDecisionExperiments();

  return (
    <Page
      title="Decision experiments"
      subtitle="Two read-only shadow experiments: what a model answers about gates and runs, set beside what Argus recorded."
    >
      {/* In the order they are numbered. */}
      <DecisionH1Section />
      <section aria-labelledby="decision-h2-title" className="mt-14 border-t border-line pt-10">
        <ExperimentHeader
          id="decision-h2-title"
          icon="activity"
          title="H2 — run termination and failure cause"
        >
          Asks how a finished run ended, which Argus can check, and why an unsuccessful one failed,
          which it cannot.
        </ExperimentHeader>
        {error && (
          <div className="mb-6">
            <AlertStrip
              subject="Experiments"
              message={loadError("the H2 report", error)}
              action={
                <Button size="sm" icon="retry" onClick={refresh}>
                  Retry
                </Button>
              }
            />
          </div>
        )}
        <Handoff busy={loading && !data} label="H2 report" skeleton={<SkeletonRows count={4} />}>
          {data ? <Report data={data} /> : !error && <NoReport name="H2" />}
        </Handoff>
      </section>
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
  // Nothing in the ledger yet — the first-run state, and the default one,
  // since collection is off until someone turns it on. The rest of the report
  // is all zeros then, so it folds away behind the one thing worth saying.
  const empty = report.asOf.seq === 0 && report.census.length === 0 && noAssessments;
  const assessmentsEmpty = (
    <EmptyState compact={!empty} icon="inbox" title="No shadow assessments recorded">
      {collection.enabled ? (
        "Collection is on. A sampled run is assessed once it is between 10 minutes and 24 hours old."
      ) : (
        <TurnOnCollection
          reasons={collection.reasons}
          then="A sampled run is then assessed once it is between 10 minutes and 24 hours old, within the call and spend caps under Settings."
        />
      )}
    </EmptyState>
  );
  return (
    <>
      {/* With the report, as H1's is: the caveat is about these figures. */}
      <Notice title="Shadow measurement only">
        These assessments are never read by any route, gate, retry or approval, and nothing here
        authorises an approval. Probe results measure recovery of an observed fact; they are not
        residual-cause accuracy. Residual-cause accuracy is unmeasured until valid reference labels
        exist.
      </Notice>

      <CollectionSection status={collection} collection={report.collection} />
      {empty ? (
        <>
          <Section title="Assessments">{assessmentsEmpty}</Section>
          <ReportDetails hint="The questions, baselines and methods, and the census and integrity checks — all empty until a run is sampled.">
            <ReportBody report={report} noAssessments />
          </ReportDetails>
        </>
      ) : (
        <ReportBody
          report={report}
          noAssessments={noAssessments}
          assessmentsEmpty={assessmentsEmpty}
        />
      )}

      <AsOf>
        H2 report as of ledger record {report.asOf.seq} ({report.asOf.at ?? "no records"}). Opening
        this page never starts collection or calls a model.
      </AsOf>
    </>
  );
}

/** Everything in the report below its collection state. */
function ReportBody({
  report,
  noAssessments,
  assessmentsEmpty,
}: {
  report: H2Report;
  noAssessments: boolean;
  /** Said in place of the populations when there are none; absent when it
   *  has already been said above. */
  assessmentsEmpty?: ReactNode;
}) {
  return (
    <>
      <QuestionsSection definitions={report.definitions} />

      <Section title="Census">
        {report.census.length === 0 ? (
          <EmptyRow>No census recorded</EmptyRow>
        ) : (
          <div className="flex flex-col gap-3">
            {report.census.map((t) => (
              <CensusCard key={`${t.role}:${t.question.id}@${t.question.version}`} table={t} />
            ))}
          </div>
        )}
      </Section>

      {noAssessments ? (
        assessmentsEmpty && <Section title="Assessments">{assessmentsEmpty}</Section>
      ) : (
        <>
          {report.probe.length > 0 && (
            <Section title="Probe question">
              <p className="-mt-1 mb-3 max-w-3xl text-small text-ink-dim">
                From this trace alone, how did the run end? Asked of a blind projection, with
                status, exit code and error withheld, and scored against the termination Argus
                observed.
              </p>
              <div className="flex flex-col gap-3">
                {report.probe.map((p) => (
                  <ProbeCard key={populationKey(p)} p={p} />
                ))}
              </div>
            </Section>
          )}
          {report.residual.length > 0 && (
            <Section title="Residual question">
              <p className="-mt-1 mb-3 max-w-3xl text-small text-ink-dim">
                Why did an unsuccessful run not accomplish its task? Nothing records the true cause,
                so these answers are described, never scored.
              </p>
              <div className="flex flex-col gap-3">
                {report.residual.map((p) => (
                  <ResidualCard key={populationKey(p)} p={p} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      <BaselinesSection baselines={report.baselines} />

      <Section title="Integrity">
        <IntegrityCard
          integrity={report.integrity}
          empty="No findings recorded"
          facts={[
            ["History (ledger, journal and joins)", report.integrity.history],
            ["Journal gaps", String(report.integrity.journal.gaps)],
            ["Journal assessments outside the experiment", String(report.outsideExperiment)],
          ]}
        />
      </Section>

      <Section title="Methods">
        <MethodsPanel methods={report.methods} />
      </Section>
    </>
  );
}
