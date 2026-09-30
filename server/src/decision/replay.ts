import type {
  AnswerSpace,
  DecisionAnswer,
  DecisionAssessment,
  ProviderIdentity,
} from "@argus/contracts";
import { answerKeys } from "./answers.js";
import { canonicalJson } from "./canonical.js";
import type { DecisionJournal, JournalNoticeKind, JournalView, SnapshotLookup } from "./journal.js";
import type { DecisionRegistry } from "./registry.js";

/**
 * Replay: a report recomputed from the journal alone (RFC §F.3).
 *
 * Replay is a **reader**. It takes no provider, makes no call and spends
 * nothing. Given the same retained records and the same named definitions (the
 * report version and the registered questions), it emits the same canonical
 * bytes. Nothing in it reads the wall clock, a random source or live Argus
 * state. Ordering is the journal's own (segment, then line), and every map is
 * emitted through canonical JSON, so keys are sorted.
 *
 * Physical storage is deliberately absent: which store a segment or snapshot
 * lives in, sealing, and the manifest's own bookkeeping. Archival therefore
 * leaves the report byte-identical. Gaps (tombstoned or missing segments),
 * unavailable or damaged snapshots and integrity findings in the records are
 * reported explicitly, never smoothed over.
 */

export interface ReportRef {
  id: string;
  version: number;
}

export const JOURNAL_REPORT_V1: ReportRef = { id: "decision-journal-report", version: 1 };

const SUPPORTED = new Set([`${JOURNAL_REPORT_V1.id}@${JOURNAL_REPORT_V1.version}`]);

/** Integrity findings that describe records, not where they are stored. */
const RECORD_NOTICES: ReadonlySet<JournalNoticeKind> = new Set<JournalNoticeKind>([
  "torn-tail",
  "recovered-torn-write",
  "corrupt-line",
  "malformed-record",
  "missing-header",
  "duplicate",
  "conflict",
]);

export type SnapshotAvailability = "retained" | "unavailable" | "corrupt";

function providerKey(p: ProviderIdentity): string {
  return canonicalJson({
    provider: p.provider,
    requestedModel: p.requestedModel,
    reportedModel: p.reportedModel,
    adapterVersion: p.adapterVersion,
    elicitation: p.elicitation,
  });
}

/** The top answer, ties broken by the answer space's declared order. */
function topAnswer(space: AnswerSpace | null, answer: DecisionAnswer): string | null {
  if (answer.kind !== "probability") return null;
  if (answer.shape === "binary") return answer.p > 0.5 ? "yes" : answer.p < 0.5 ? "no" : "tie";
  const keys = space ? answerKeys(space) : Object.keys(answer.p).sort();
  let best: string | null = null;
  for (const k of keys) {
    const v = answer.p[k];
    if (typeof v !== "number") continue;
    if (best === null || v > answer.p[best]) best = k;
  }
  return best;
}

/**
 * Render the report from a journal view and each snapshot's availability.
 * Pure: the same arguments always produce the same bytes.
 */
export function renderReport(
  view: JournalView,
  availability: ReadonlyMap<string, SnapshotAvailability>,
  registry: DecisionRegistry,
  report: ReportRef,
): string {
  if (!SUPPORTED.has(`${report.id}@${report.version}`)) {
    throw new Error(`unknown report definition ${report.id}@${report.version}`);
  }
  const ids = new Set(view.entries.map((e) => e.assessment.id));
  const definition = (a: DecisionAssessment) => {
    const q = registry.question(a.question.id, a.question.version);
    if (!q) return { status: "missing" as const, space: null };
    if (q.ref.digest !== a.question.digest)
      return { status: "digest-mismatch" as const, space: null };
    return { status: "registered" as const, space: q.def.answers };
  };

  type Tally = {
    question: { id: string; version: number };
    definition: string;
    provider: ProviderIdentity;
    answered: number;
    abstained: number;
    failed: number;
    top: Record<string, number>;
  };
  const tallies = new Map<string, Tally>();

  const assessments = view.entries.map((e) => {
    const a = e.assessment;
    const def = definition(a);
    const snapshot = availability.get(a.snapshot.sha256) ?? "unavailable";
    let outcome: Record<string, unknown>;
    let top: string | null = null;
    if (a.outcome.status === "answered") {
      top = topAnswer(def.space, a.outcome.answer);
      outcome = {
        status: "answered",
        answer: a.outcome.answer,
        normalized: a.outcome.normalization !== undefined,
        top,
      };
    } else if (a.outcome.status === "abstained") {
      outcome = { status: "abstained", reason: a.outcome.reason };
    } else {
      outcome = { status: "failed", failure: a.outcome.failure };
    }
    const key = canonicalJson([a.question.id, a.question.version, providerKey(a.provider)]);
    const t: Tally = tallies.get(key) ?? {
      question: { id: a.question.id, version: a.question.version },
      definition: def.status,
      provider: a.provider,
      answered: 0,
      abstained: 0,
      failed: 0,
      top: {},
    };
    t[
      a.outcome.status === "answered"
        ? "answered"
        : a.outcome.status === "abstained"
          ? "abstained"
          : "failed"
    ]++;
    if (top !== null) t.top[top] = (t.top[top] ?? 0) + 1;
    tallies.set(key, t);
    return {
      id: a.id,
      at: { segment: e.segment, line: e.line },
      question: { id: a.question.id, version: a.question.version, definition: def.status },
      subject: a.subject,
      provider: a.provider,
      sample: a.sample,
      reEvaluates: a.reEvaluates ?? null,
      reEvaluatesFound: a.reEvaluates === undefined ? null : ids.has(a.reEvaluates),
      mode: a.mode,
      outcome,
      snapshot: {
        sha256: a.snapshot.sha256,
        bytes: a.snapshot.bytes,
        projection: { id: a.snapshot.projection.id, version: a.snapshot.projection.version },
        availability: snapshot,
        reEvaluable: snapshot === "retained",
      },
    };
  });

  const byQuestion = [...tallies.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, t]) => t);

  const doc = {
    report: { id: report.id, version: report.version },
    segments: view.segments.map((s) => ({ segment: s.segment, records: s.records })),
    gaps: view.gaps,
    integrity: view.notices
      .filter((n) => RECORD_NOTICES.has(n.kind))
      .map((n) => ({
        kind: n.kind,
        segment: n.segment ?? null,
        line: n.line ?? null,
        detail: n.detail,
      })),
    totals: {
      assessments: assessments.length,
      unavailableSnapshots: assessments.filter((a) => a.snapshot.availability !== "retained")
        .length,
    },
    questions: byQuestion,
    assessments,
  };
  return `${canonicalJson(doc)}\n`;
}

/** Replay the journal into report bytes. Reads the journal and its snapshots; calls nothing else. */
export async function replay(
  journal: DecisionJournal,
  registry: DecisionRegistry,
  report: ReportRef = JOURNAL_REPORT_V1,
): Promise<string> {
  const view = await journal.read();
  const availability = new Map<string, SnapshotAvailability>();
  for (const sha of [...new Set(view.entries.map((e) => e.assessment.snapshot.sha256))].sort()) {
    const found: SnapshotLookup = await journal.loadSnapshot(sha);
    availability.set(sha, found.status);
  }
  return renderReport(view, availability, registry, report);
}
