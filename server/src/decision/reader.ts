import type {
  AssessmentCurrency,
  DecisionAssessment,
  DecisionSubject,
  DefinitionRef,
  ProviderIdentity,
  StoredSnapshot,
} from "@argus/contracts";
import { checkOutcome } from "./answers.js";
import { canonicalDigest, canonicalJson, SHA256_RE } from "./canonical.js";
import { deriveCurrency } from "./currency.js";
import {
  ASSESSMENT_ID_RE,
  type DecisionJournal,
  type JournalView,
  type SnapshotLookup,
} from "./journal.js";
import type { DecisionSources, ProjectionBuilder } from "./projection.js";
import type { DecisionRegistry } from "./registry.js";

export interface AdvisoryConsumer {
  id: string;
  question: DefinitionRef;
  projection: DefinitionRef;
  providers: readonly ProviderIdentity[];
}

export type AdvisoryReason =
  | "failed"
  | "abstained"
  | "invalid-answer"
  | "snapshot-corrupt"
  | "snapshot-unavailable"
  | "snapshot-identity-mismatch"
  | "journal-integrity"
  | "stale"
  | "currency-unavailable";
export interface AdvisoryAssessment {
  assessment: DecisionAssessment;
  provenance: { segment: string; line: number; digest: string };
  integrity: Pick<JournalView, "gaps" | "notices">;
  retained: SnapshotLookup;
  currency: AssessmentCurrency;
  presentation: "current" | "stale" | "historical" | "unavailable";
  usable: boolean;
  reasons: AdvisoryReason[];
  cost: { status: "known"; usd: number } | { status: "unknown"; usd: null };
  authority: "inference-only";
}
export type AdvisoryReadResult =
  | { ok: true; value: AdvisoryAssessment }
  | {
      ok: false;
      reason:
        | "invalid-id"
        | "unknown-consumer"
        | "unknown-assessment"
        | "subject-mismatch"
        | "unsupported-question"
        | "unsupported-projection"
        | "unsupported-provider"
        | "journal-unavailable"
        | "malformed-assessment";
    };

export interface DecisionReader {
  read(input: {
    assessmentId: string;
    consumerId: string;
    subject: DecisionSubject;
  }): Promise<AdvisoryReadResult>;
}
export interface DecisionReaderDeps {
  journal: Pick<DecisionJournal, "read" | "loadSnapshot">;
  registry: DecisionRegistry;
  builders: readonly ProjectionBuilder[];
  sources: DecisionSources;
  consumers: readonly AdvisoryConsumer[];
}

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const benign = new Set(["torn-tail", "recovered-torn-write", "duplicate"]);

function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
const text = (v: unknown) => typeof v === "string" && v.length > 0;
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function definition(v: unknown): boolean {
  return (
    record(v) &&
    text(v.id) &&
    count(v.version) &&
    (v.version as number) > 0 &&
    typeof v.digest === "string" &&
    SHA256_RE.test(v.digest)
  );
}
function subject(v: unknown): boolean {
  if (!record(v)) return false;
  switch (v.kind) {
    case "run":
      return text(v.runId);
    case "phase-attempt":
      return text(v.instanceId) && text(v.phaseId) && count(v.attempt);
    case "rule-verification":
    case "acceptance-verification":
      return text(v.verificationId);
    default:
      return false;
  }
}
function readableAssessment(v: unknown): v is DecisionAssessment {
  if (
    !record(v) ||
    !definition(v.question) ||
    !subject(v.subject) ||
    !record(v.snapshot) ||
    !definition(v.snapshot.projection) ||
    !record(v.provider) ||
    !record(v.outcome)
  )
    return false;
  const p = v.provider;
  const nullableText = (x: unknown) => x === null || typeof x === "string";
  const numeric = (x: unknown) =>
    x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
  const outcome = v.outcome;
  const validOutcome =
    outcome.status === "answered"
      ? record(outcome.answer)
      : outcome.status === "abstained"
        ? typeof outcome.reason === "string"
        : outcome.status === "failed" &&
          text(outcome.failure) &&
          typeof outcome.detail === "string";
  return (
    typeof v.snapshot.sha256 === "string" &&
    SHA256_RE.test(v.snapshot.sha256) &&
    count(v.snapshot.bytes) &&
    text(p.provider) &&
    nullableText(p.requestedModel) &&
    nullableText(p.reportedModel) &&
    count(p.adapterVersion) &&
    (p.adapterVersion as number) > 0 &&
    typeof p.elicitation === "string" &&
    ["native", "verbalized", "sampled", "rule", "label"].includes(p.elicitation) &&
    validOutcome &&
    count(v.sample) &&
    numeric(v.costUsd) &&
    numeric(v.tokens) &&
    typeof v.latencyMs === "number" &&
    Number.isFinite(v.latencyMs) &&
    v.latencyMs >= 0 &&
    text(v.createdAt) &&
    typeof v.mode === "string" &&
    ["shadow", "advisory", "enforcing"].includes(v.mode)
  );
}
function snapshotMatches(a: DecisionAssessment, s: StoredSnapshot): boolean {
  try {
    if (
      !record(s.content) ||
      !record(s.content.refs) ||
      ![
        s.content.refs.runs,
        s.content.refs.claims,
        s.content.refs.verifications,
        s.content.refs.artifacts,
        s.content.subjectAuthored,
        s.content.redactions,
        s.content.truncations,
      ].every(Array.isArray)
    )
      return false;
    const refs = s.content.refs;
    if (
      !refs.runs.every(text) ||
      !refs.verifications.every(text) ||
      !refs.claims.every((r) => record(r) && text(r.id) && count(r.revision) && r.revision > 0) ||
      !refs.artifacts.every(
        (r) => record(r) && text(r.path) && ["artifact-dir", "repository"].includes(r.location),
      ) ||
      !s.content.subjectAuthored.every((p) => typeof p === "string")
    )
      return false;
    const sealed = canonicalDigest(s.content);
    return (
      sealed.sha256 === a.snapshot.sha256 &&
      sealed.sha256 === s.sha256 &&
      sealed.bytes === a.snapshot.bytes &&
      sealed.bytes === s.bytes &&
      s.content.format === "argus.decision-snapshot" &&
      s.content.formatVersion === 1 &&
      equal(s.content.subject, a.subject) &&
      equal(s.content.projection, a.snapshot.projection)
    );
  } catch {
    return false;
  }
}

export function createDecisionReader(deps: DecisionReaderDeps): DecisionReader {
  const consumers = structuredClone(deps.consumers);
  if (new Set(consumers.map((c) => c.id)).size !== consumers.length)
    throw new Error("duplicate advisory consumer id");
  return {
    async read(req: {
      assessmentId: string;
      consumerId: string;
      subject: DecisionSubject;
    }): Promise<AdvisoryReadResult> {
      if (!ASSESSMENT_ID_RE.test(req.assessmentId)) return { ok: false, reason: "invalid-id" };
      const consumer = consumers.find((c) => c.id === req.consumerId);
      if (!consumer) return { ok: false, reason: "unknown-consumer" };
      let view: JournalView;
      try {
        view = await deps.journal.read();
      } catch {
        return { ok: false, reason: "journal-unavailable" };
      }
      const entry = view.entries.find((e) => e.assessment.id === req.assessmentId);
      const assessment = entry?.assessment;
      if (!assessment) return { ok: false, reason: "unknown-assessment" };
      if (!readableAssessment(assessment)) return { ok: false, reason: "malformed-assessment" };
      if (!equal(assessment.subject, req.subject)) return { ok: false, reason: "subject-mismatch" };
      const q = deps.registry.question(assessment.question.id, assessment.question.version);
      if (
        !equal(assessment.question, consumer.question) ||
        !q ||
        !equal(q.ref, assessment.question) ||
        q.def.subject !== assessment.subject.kind
      )
        return { ok: false, reason: "unsupported-question" };
      const p = deps.registry.projection(
        assessment.snapshot.projection.id,
        assessment.snapshot.projection.version,
      );
      if (
        !equal(assessment.snapshot.projection, consumer.projection) ||
        !p ||
        !equal(p.ref, consumer.projection) ||
        q.def.projection.id !== p.ref.id ||
        q.def.projection.version !== p.ref.version
      )
        return { ok: false, reason: "unsupported-projection" };
      if (!consumer.providers.some((identity) => equal(identity, assessment.provider)))
        return { ok: false, reason: "unsupported-provider" };
      const reasons: AdvisoryReason[] = [];
      if (view.gaps.length || view.notices.some((n) => !benign.has(n.kind)))
        reasons.push("journal-integrity");
      let retained: SnapshotLookup;
      try {
        retained = await deps.journal.loadSnapshot(assessment.snapshot.sha256);
      } catch {
        retained = { status: "corrupt", detail: "retained snapshot could not be read" };
      }
      if (retained.status === "corrupt") reasons.push("snapshot-corrupt");
      else if (retained.status === "unavailable") reasons.push("snapshot-unavailable");
      else if (!snapshotMatches(assessment, retained.snapshot))
        reasons.push("snapshot-identity-mismatch");
      if (assessment.outcome.status !== "answered") reasons.push(assessment.outcome.status);
      else if (checkOutcome(q.def.answers, assessment.outcome)) reasons.push("invalid-answer");
      let currency: AssessmentCurrency;
      try {
        currency = await deriveCurrency(assessment, deps);
      } catch {
        currency = {
          assessmentId: assessment.id,
          status: "unavailable",
          checks: [
            {
              check: "snapshot",
              status: "unavailable",
              detail: "live applicability could not be derived",
            },
          ],
        };
      }
      if (currency.status === "stale") reasons.push("stale");
      else if (currency.status === "unavailable") reasons.push("currency-unavailable");
      const evidenceUnavailable = reasons.some(
        (r) => r === "journal-integrity" || r.startsWith("snapshot-"),
      );
      const presentation = evidenceUnavailable
        ? "unavailable"
        : currency.status === "unavailable"
          ? "historical"
          : currency.status;
      const cost =
        typeof assessment.costUsd === "number" &&
        Number.isFinite(assessment.costUsd) &&
        assessment.costUsd >= 0
          ? { status: "known" as const, usd: assessment.costUsd }
          : { status: "unknown" as const, usd: null };
      return {
        ok: true,
        value: {
          assessment,
          provenance: { segment: entry!.segment, line: entry!.line, digest: entry!.digest },
          integrity: { gaps: view.gaps, notices: view.notices },
          retained,
          currency,
          presentation,
          usable: reasons.length === 0,
          reasons,
          cost,
          authority: "inference-only",
        },
      };
    },
  };
}
