import type {
  AcceptanceVerificationPreview,
  Anomaly,
  Baseline,
  ChangeProposalPreview,
  DecisionProjection,
  DefinitionRef,
  KnowledgeDeltaPreview,
  KnowledgeScope,
  PhaseDef,
  PhaseProgress,
  PhaseReview,
  PipelineInstance,
  RepositoryStateRef,
  RuleVerificationPreview,
  Run,
  StoredSnapshot,
  VerificationEvidence,
  VerificationReport,
} from "@argus/contracts";
import { canonicalDigest, canonicalJson } from "../canonical.js";
import { sealSnapshot, type BuildResult } from "../projection.js";
import { BodyShaper, REDACTION_RULES_V1 } from "../redaction.js";
import { GATE_REVIEW_CAPS as CAP } from "./definitions.js";

/**
 * The `gate-review` v1 projection (RFC §H.3, §Q.4): one phase attempt at an
 * ordinary gate, as the gate drawer's own review model (`buildPhaseReview`)
 * and Argus's records show it at capture.
 *
 * Two halves. `GateReviewInput` is everything gathered, raw; the collector
 * (`collect.ts`) fills it from the real stores, and tests fill it by hand.
 * `projectGateReview` is pure: it shapes, redacts, truncates and seals, and
 * the same input always gives the same bytes.
 *
 * Every field that could be absent says why. `unavailable` (the record should
 * exist and could not be read) is never shown as empty, and `not-declared`
 * (the phase asked for nothing) is never shown as passed.
 *
 * What is never here: any gate-decision record (earlier attempts' included),
 * `gateDecisionIds`, `pendingGateOperation`, Verdict scores (a baseline, kept
 * apart), file content and command output.
 */

// ── Input ───────────────────────────────────────────────────────────────────

export type Availability<T> =
  ({ status: "available" } & T) | { status: "unavailable"; reason: string };

export interface GateChangesInput {
  files: Availability<{ source: "attempt-worktree" | "phase-baseline"; paths: string[] }>;
  diffStat: Availability<{ files: number; insertions: number; deletions: number; binary: number }>;
  repository: RepositoryStateRef | null;
}

export interface GateReviewInput {
  instance: PipelineInstance;
  phase: PhaseProgress;
  phaseDef: PhaseDef | undefined;
  /** The drawer's review model for this phase, or why it could not be built. */
  review: { ok: true; review: PhaseReview } | { ok: false; reason: string };
  /** Relevant runs by id; a missing entry is a run record that could not be read. */
  runs: ReadonlyMap<string, Run>;
  watchtower: { anomalies: Anomaly[]; baselines: Baseline[]; keyOf: (run: Run) => string } | null;
  changes: GateChangesInput;
}

// ── Body ────────────────────────────────────────────────────────────────────

interface StepBody {
  name: string;
  runId: string;
  status: string;
  run:
    | {
        status: "available";
        prompt: string;
        finalMessage: string | null;
        /** Capture-time context, outside the review-state digest: it is backfilled late. */
        context: {
          durationMs: number | null;
          costUsd: number | null;
          tokens: number | null;
          model: string | null;
          runtime: string | null;
        };
      }
    | { status: "unavailable"; reason: string };
}

interface StagedSection<Row> {
  /** Relevant steps whose sidecar names a staged record of this kind. */
  expected: number;
  /** Of those, the runs whose record the review model could not read. */
  unavailable: string[];
  rows: Row[];
  rowsOmitted: number;
}

interface Warning {
  code: string;
  message: string;
}

interface OutcomeEntry {
  ref: string;
  outcome: string;
  evidenceKinds: string[];
  reason: string | null;
}

export interface GateReviewBody {
  gate: {
    pipelineName: string;
    phaseName: string;
    attempt: number;
    retries: number;
    candidates: { count: number; selected: number | null } | null;
    relevantRuns: string[];
  };
  steps: StepBody[];
  stepsOmitted: number;
  result: { status: "not-declared" } | { status: "missing" } | { status: "present"; json: string };
  verification:
    | { status: "not-declared" }
    | { status: "missing" }
    | {
        status: "present";
        report: {
          status: string;
          checks: Array<{
            kind: string;
            label: string;
            status: string;
            exitCode: number | null;
            detail: string;
          }>;
          checksOmitted: number;
        };
      };
  changes: {
    files:
      | { status: "available"; source: string; total: number; paths: string[] }
      | { status: "unavailable"; reason: string };
    diffStat:
      | {
          status: "available";
          files: number;
          insertions: number;
          deletions: number;
          binary: number;
        }
      | { status: "unavailable"; reason: string };
  };
  staged:
    | { status: "unavailable"; reason: string }
    | {
        status: "available";
        knowledge: StagedSection<{
          runId: string;
          status: string;
          claims: number;
          revisions: number;
          evidenceKinds: string[];
          warnings: Warning[];
          summary: string | null;
        }>;
        ruleVerifications: StagedSection<{
          runId: string;
          status: string;
          counts: { holds: number; violated: number; unverifiable: number };
          entries: OutcomeEntry[];
          entriesOmitted: number;
        }>;
        changeProposals: StagedSection<{
          runId: string;
          status: string;
          readiness: string;
          warnings: Warning[];
          unresolved: number;
          acceptanceCriteria: number;
          summary: string | null;
        }>;
        acceptance: StagedSection<{
          runId: string;
          status: string;
          counts: { satisfied: number; violated: number; unverifiable: number };
          entries: OutcomeEntry[];
          entriesOmitted: number;
        }>;
      };
  /** Capture-time context, outside the review-state digest: relative to baselines other runs move. */
  anomalies:
    | {
        status: "available";
        runs: Array<{
          runId: string;
          baseline: "ready" | "warming" | "none";
          anomalies: Array<{ metric: string; direction: string; severity: string; ratio: number }>;
        }>;
      }
    | { status: "unavailable"; reason: string };
  artifacts:
    | { status: "none" }
    | { status: "unavailable"; reason: string }
    | {
        status: "available";
        total: number;
        listingTruncated: boolean;
        items: Array<{ path: string; bytes: number }>;
      };
}

// ── Shaping ─────────────────────────────────────────────────────────────────

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const uniqSorted = (xs: string[]) => [...new Set(xs)].sort(cmp);
const round6 = (x: number) => {
  const r = Math.round(x * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};
const finiteOrNull = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? round6(v) : null;

/** The steps whose output passes this gate: the selected candidate's on a best-of-N phase. */
export function relevantSteps(phase: PhaseProgress) {
  return phase.selectedCandidate != null
    ? phase.steps.filter((s) => s.candidate === phase.selectedCandidate)
    : phase.steps;
}

function evidenceKinds(evidence: readonly VerificationEvidence[] | undefined): string[] {
  return uniqSorted((evidence ?? []).map((e) => e.type));
}

function verificationBody(
  report: VerificationReport | undefined,
  declared: boolean,
  sh: BodyShaper,
): GateReviewBody["verification"] {
  if (!report) return declared ? { status: "missing" } : { status: "not-declared" };
  const checks = report.checks.slice(0, CAP.checks).map((c, i) => ({
    kind: c.kind,
    label: sh.text(`/verification/report/checks/${i}/label`, c.label, CAP.name),
    status: c.status,
    exitCode: typeof c.exitCode === "number" ? c.exitCode : null,
    detail: sh.text(`/verification/report/checks/${i}/detail`, c.detail, CAP.checkDetail),
  }));
  return {
    status: "present",
    report: {
      status: report.status,
      checks,
      checksOmitted: Math.max(0, report.checks.length - CAP.checks),
    },
  };
}

function section<P, Row>(
  expectedRuns: string[],
  previews: readonly P[],
  runOf: (p: P) => string,
  row: (p: P, i: number) => Row,
): StagedSection<Row> {
  const relevant = new Set(expectedRuns);
  const found = previews.filter((p) => relevant.has(runOf(p)));
  const seen = new Set(found.map(runOf));
  return {
    expected: expectedRuns.length,
    unavailable: expectedRuns.filter((r) => !seen.has(r)).sort(cmp),
    rows: found.slice(0, CAP.stagedRows).map(row),
    rowsOmitted: Math.max(0, found.length - CAP.stagedRows),
  };
}

function outcomeEntries(
  groups: Array<
    [string, ReadonlyArray<{ ref: string; evidence: VerificationEvidence[]; reason?: string }>]
  >,
  base: string,
  sh: BodyShaper,
): { entries: OutcomeEntry[]; entriesOmitted: number } {
  const all = groups.flatMap(([outcome, rows]) => rows.map((r) => ({ outcome, r })));
  const entries = all.slice(0, CAP.stagedRows).map(({ outcome, r }, i) => ({
    ref: sh.text(`${base}/${i}/ref`, r.ref, CAP.name),
    outcome,
    evidenceKinds: evidenceKinds(r.evidence),
    reason: r.reason === undefined ? null : sh.text(`${base}/${i}/reason`, r.reason, CAP.message),
  }));
  return { entries, entriesOmitted: Math.max(0, all.length - CAP.stagedRows) };
}

function warnings(
  ws: ReadonlyArray<{ code: string; message: string }> | undefined,
  base: string,
  sh: BodyShaper,
): Warning[] {
  return (ws ?? []).slice(0, CAP.stagedRows).map((w, i) => ({
    code: w.code,
    message: sh.text(`${base}/${i}/message`, w.message, CAP.message),
  }));
}

function stagedBody(
  input: GateReviewInput,
  runIds: string[],
  sh: BodyShaper,
): GateReviewBody["staged"] {
  if (!input.review.ok) return { status: "unavailable", reason: input.review.reason };
  const review = input.review.review;
  const steps = relevantSteps(input.phase).filter((s) => s.runId);
  const expected = (has: (s: (typeof steps)[number]) => boolean) =>
    steps.filter(has).map((s) => s.runId as string);
  const inRelevant = new Set(runIds);
  const k = (review.knowledge ?? []).filter((p) => inRelevant.has(p.runId));
  const rv = (review.ruleVerifications ?? []).filter((p) => inRelevant.has(p.runId));
  const cp = (review.changeProposals ?? []).filter((p) => inRelevant.has(p.runId));
  const av = (review.acceptanceVerifications ?? []).filter((p) => inRelevant.has(p.runId));
  return {
    status: "available",
    knowledge: section(
      expected((s) => !!s.knowledgeDelta),
      k,
      (p: KnowledgeDeltaPreview) => p.runId,
      (p, i) => ({
        runId: p.runId,
        status: p.status,
        claims: p.proposedClaims.length,
        revisions: p.proposedRevisions.length,
        evidenceKinds: uniqSorted(p.evidence.map((e) => e.source.type)),
        warnings: warnings(p.warnings, `/staged/knowledge/rows/${i}/warnings`, sh),
        summary:
          p.summary === undefined
            ? null
            : sh.text(`/staged/knowledge/rows/${i}/summary`, p.summary, CAP.message),
      }),
    ),
    ruleVerifications: section(
      expected((s) => !!s.ruleVerification),
      rv,
      (p: RuleVerificationPreview) => p.runId,
      (p, i) => ({
        runId: p.runId,
        status: p.status,
        counts: {
          holds: p.holds.length,
          violated: p.violated.length,
          unverifiable: p.unverifiable.length,
        },
        ...outcomeEntries(
          [
            ["holds", p.holds],
            ["violated", p.violated],
            ["unverifiable", p.unverifiable],
          ],
          `/staged/ruleVerifications/rows/${i}/entries`,
          sh,
        ),
      }),
    ),
    changeProposals: section(
      expected((s) => !!s.changeProposal),
      cp,
      (p: ChangeProposalPreview) => p.runId,
      (p, i) => ({
        runId: p.runId,
        status: p.status,
        readiness: p.readiness,
        warnings: warnings(p.warnings, `/staged/changeProposals/rows/${i}/warnings`, sh),
        unresolved: p.unresolved.length,
        acceptanceCriteria: p.acceptanceCriteria.length,
        summary:
          p.summary === undefined
            ? null
            : sh.text(`/staged/changeProposals/rows/${i}/summary`, p.summary, CAP.message),
      }),
    ),
    acceptance: section(
      expected((s) => !!s.acceptanceVerification),
      av,
      (p: AcceptanceVerificationPreview) => p.runId,
      (p, i) => ({
        runId: p.runId,
        status: p.status,
        counts: {
          satisfied: p.satisfied.length,
          violated: p.violated.length,
          unverifiable: p.unverifiable.length,
        },
        ...outcomeEntries(
          [
            ["satisfied", p.satisfied],
            ["violated", p.violated],
            ["unverifiable", p.unverifiable],
          ],
          `/staged/acceptance/rows/${i}/entries`,
          sh,
        ),
      }),
    ),
  };
}

function anomaliesBody(input: GateReviewInput, runIds: string[]): GateReviewBody["anomalies"] {
  const w = input.watchtower;
  if (!w) return { status: "unavailable", reason: "the Watchtower report could not be read" };
  const byKey = new Map(w.baselines.map((b) => [b.key, b]));
  const runs = runIds.slice(0, CAP.anomalies).map((runId) => {
    const run = input.runs.get(runId);
    const b = run ? byKey.get(w.keyOf(run)) : undefined;
    const found = w.anomalies
      .filter((a) => a.runId === runId)
      .map((a) => ({
        metric: a.metric,
        direction: a.direction,
        severity: a.severity,
        ratio: round6(a.ratio),
      }))
      .sort((a, b) => cmp(`${a.metric}|${a.direction}`, `${b.metric}|${b.direction}`));
    return {
      runId,
      baseline: !b
        ? ("none" as const)
        : b.warmupRemaining > 0
          ? ("warming" as const)
          : ("ready" as const),
      anomalies: found,
    };
  });
  return { status: "available", runs };
}

function artifactsBody(input: GateReviewInput, sh: BodyShaper): GateReviewBody["artifacts"] {
  if (!input.review.ok) return { status: "unavailable", reason: input.review.reason };
  const r = input.review.review;
  if (!r.artifactDir) return { status: "none" };
  const items = [...r.artifacts]
    .sort((a, b) => cmp(a.path, b.path))
    .slice(0, CAP.artifacts)
    .map((a, i) => ({
      path: sh.text(`/artifacts/items/${i}/path`, a.path, CAP.path),
      bytes: a.bytes,
    }));
  return { status: "available", total: r.artifacts.length, listingTruncated: !!r.truncated, items };
}

function changesBody(input: GateReviewInput, sh: BodyShaper): GateReviewBody["changes"] {
  const f = input.changes.files;
  const d = input.changes.diffStat;
  const paths = f.status === "available" ? uniqSorted(f.paths) : [];
  return {
    files:
      f.status === "available"
        ? {
            status: "available",
            source: f.source,
            total: paths.length,
            paths: paths
              .slice(0, CAP.paths)
              .map((p, i) => sh.text(`/changes/files/paths/${i}`, p, CAP.path)),
          }
        : { status: "unavailable", reason: f.reason },
    diffStat:
      d.status === "available"
        ? {
            status: "available",
            files: d.files,
            insertions: d.insertions,
            deletions: d.deletions,
            binary: d.binary,
          }
        : { status: "unavailable", reason: d.reason },
  };
}

/** JSON pointers to text the assessed agent wrote or chose, present in this body. */
function subjectAuthored(body: GateReviewBody): string[] {
  const out: string[] = [];
  body.steps.forEach((s, i) => {
    if (s.run.status === "available" && s.run.finalMessage !== null)
      out.push(`/steps/${i}/run/finalMessage`);
  });
  if (body.result.status === "present") out.push("/result/json");
  if (body.changes.files.status === "available") out.push("/changes/files/paths");
  if (body.artifacts.status === "available") out.push("/artifacts/items");
  if (body.staged.status === "available") {
    const s = body.staged;
    s.knowledge.rows.forEach((r, i) => {
      if (r.summary !== null) out.push(`/staged/knowledge/rows/${i}/summary`);
      if (r.warnings.length) out.push(`/staged/knowledge/rows/${i}/warnings`);
    });
    s.ruleVerifications.rows.forEach((r, i) => {
      if (r.entries.length) out.push(`/staged/ruleVerifications/rows/${i}/entries`);
    });
    s.changeProposals.rows.forEach((r, i) => {
      if (r.summary !== null) out.push(`/staged/changeProposals/rows/${i}/summary`);
      if (r.warnings.length) out.push(`/staged/changeProposals/rows/${i}/warnings`);
    });
    s.acceptance.rows.forEach((r, i) => {
      if (r.entries.length) out.push(`/staged/acceptance/rows/${i}/entries`);
    });
  }
  return out.sort(cmp);
}

export interface ProjectedGateReview {
  body: GateReviewBody;
  scope: KnowledgeScope | undefined;
  repository: RepositoryStateRef | undefined;
  refs: { runs: string[]; verifications: string[] };
  subjectAuthored: string[];
}

/** Shape the gathered input into the typed, redacted and capped body. Pure. */
export function shapeGateReview(input: GateReviewInput): {
  projected: ProjectedGateReview;
  shaper: BodyShaper;
} {
  const sh = new BodyShaper(REDACTION_RULES_V1);
  const phase = input.phase;
  const steps = relevantSteps(phase);
  const runIds = steps.map((s) => s.runId).filter((id): id is string => !!id);
  const stepBodies: StepBody[] = steps.slice(0, CAP.steps).map((s, i) => {
    const run = s.runId ? input.runs.get(s.runId) : undefined;
    return {
      name: sh.text(`/steps/${i}/name`, s.name, CAP.name),
      runId: s.runId ?? "",
      status: s.status,
      run: run
        ? {
            status: "available",
            prompt: sh.text(`/steps/${i}/run/prompt`, run.prompt, CAP.prompt),
            finalMessage:
              run.resultSummary === null
                ? null
                : sh.text(`/steps/${i}/run/finalMessage`, run.resultSummary, CAP.finalMessage),
            context: {
              durationMs: finiteOrNull(run.durationMs),
              costUsd: finiteOrNull(run.costUsd),
              tokens: finiteOrNull(run.tokens),
              model: run.model ?? null,
              runtime: run.runtime ?? null,
            },
          }
        : { status: "unavailable", reason: s.runId ? "run-record-unreadable" : "step-has-no-run" },
    };
  });
  const declaresResult = !!input.phaseDef?.result;
  const result: GateReviewBody["result"] =
    phase.result === undefined
      ? declaresResult
        ? { status: "missing" }
        : { status: "not-declared" }
      : {
          status: "present",
          json: sh.text("/result/json", canonicalJson(phase.result), CAP.result),
        };
  const candidateCount = new Set(phase.steps.map((s) => s.candidate).filter((c) => c !== undefined))
    .size;
  const body: GateReviewBody = {
    gate: {
      pipelineName: sh.text("/gate/pipelineName", input.instance.pipelineName, CAP.name),
      phaseName: sh.text("/gate/phaseName", phase.name, CAP.name),
      attempt: phase.attempt,
      retries: phase.retries ?? 0,
      candidates:
        candidateCount > 0
          ? { count: candidateCount, selected: phase.selectedCandidate ?? null }
          : null,
      relevantRuns: [...runIds],
    },
    steps: stepBodies,
    stepsOmitted: Math.max(0, steps.length - CAP.steps),
    result,
    verification: verificationBody(
      phase.verification,
      (input.phaseDef?.checks?.length ?? 0) > 0,
      sh,
    ),
    changes: changesBody(input, sh),
    staged: stagedBody(input, runIds, sh),
    anomalies: anomaliesBody(input, runIds),
    artifacts: artifactsBody(input, sh),
  };
  const verifications = input.review.ok
    ? uniqSorted([
        ...(input.review.review.ruleVerifications ?? [])
          .filter((p) => runIds.includes(p.runId))
          .map((p) => p.recordId),
        ...(input.review.review.acceptanceVerifications ?? [])
          .filter((p) => runIds.includes(p.runId))
          .map((p) => p.recordId),
      ])
    : [];
  return {
    projected: {
      body,
      scope: phase.knowledgeScope,
      repository: input.changes.repository ?? undefined,
      refs: { runs: [...runIds].sort(cmp), verifications },
      subjectAuthored: subjectAuthored(body),
    },
    shaper: sh,
  };
}

/** Shape and seal. The snapshot's subject is the exact phase attempt. */
export function projectGateReview(
  projection: DefinitionRef,
  def: DecisionProjection,
  input: GateReviewInput,
): BuildResult {
  const { projected, shaper } = shapeGateReview(input);
  return sealSnapshot(projection, def, {
    subject: {
      kind: "phase-attempt",
      instanceId: input.instance.id,
      phaseId: input.phase.id,
      attempt: input.phase.attempt,
    },
    ...(projected.scope ? { scope: projected.scope } : {}),
    ...(projected.repository ? { repository: projected.repository } : {}),
    refs: {
      runs: projected.refs.runs,
      claims: [],
      verifications: projected.refs.verifications,
      artifacts: [],
    },
    subjectAuthored: projected.subjectAuthored,
    redactions: shaper.redactions(),
    truncations: shaper.truncations(),
    body: projected.body,
  });
}

/** The rule that says which fields are material to "as it stands" (§Q.3). */
export const REVIEW_STATE_RULE = "gate-review.material@1";

/**
 * The review-state digest: sha256 over the snapshot's material content — the
 * body without its capture-time context (run cost, tokens, duration, model;
 * Watchtower anomalies), plus subject, scope, repository state and refs. Two
 * captures of an unchanged gate give the same digest; a changed prompt,
 * result, check, file, staged record or artifact gives a different one.
 */
export function reviewStateDigest(snapshot: StoredSnapshot): string {
  const c = snapshot.content;
  const body = c.body as GateReviewBody;
  const material = {
    rule: REVIEW_STATE_RULE,
    projection: c.projection,
    subject: c.subject,
    scope: c.scope ?? null,
    repository: c.repository ?? null,
    refs: c.refs,
    body: {
      ...body,
      steps: body.steps.map((s) =>
        s.run.status === "available"
          ? {
              ...s,
              run: { status: s.run.status, prompt: s.run.prompt, finalMessage: s.run.finalMessage },
            }
          : s,
      ),
      anomalies: null,
    },
  };
  return canonicalDigest(material).sha256;
}
