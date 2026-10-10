import type {
  DecisionAssessment,
  DecisionSubject,
  DefinitionRef,
  ProviderIdentity,
} from "@argus/contracts";
import { checkOutcome } from "./answers.js";
import { canonicalDigest, canonicalJson, SHA256_RE } from "./canonical.js";
import type { AdvisoryReadResult } from "./reader.js";
import type { DecisionRegistry } from "./registry.js";

export interface PolicyPreparationRule {
  id: string;
  version: number;
  question: DefinitionRef;
  projection: DefinitionRef;
  provider: ProviderIdentity;
  targetAnswer:
    | { kind: "probability"; shape: "binary"; event: "p" }
    | { kind: "probability"; shape: "choice"; optionId: string };
  comparison: ">=";
  threshold: number;
  effect: "escalate" | "flag" | "withhold-auto-approval";
}
export interface PolicyPreparationInput {
  rule: PolicyPreparationRule;
  advisory: AdvisoryReadResult;
  target: { subject: DecisionSubject; stateDigest: string };
}
export interface PreparedPolicyIntent {
  status: "prepared";
  applied: false;
  authority: "inference-only";
  rule: DefinitionRef;
  assessmentId: string;
  assessmentDigest: string;
  question: DefinitionRef;
  projection: DefinitionRef;
  provider: ProviderIdentity;
  sample: number;
  snapshot: DecisionAssessment["snapshot"];
  subject: DecisionSubject;
  target: PolicyPreparationInput["target"];
  targetAnswer: PolicyPreparationRule["targetAnswer"];
  probability: number;
  comparison: ">=";
  threshold: number;
  effect: PolicyPreparationRule["effect"];
  digest: string;
}
export type PolicyPreparationRefusal = {
  ok: false;
  reason:
    | "malformed-input"
    | "invalid-rule"
    | "invalid-target"
    | "unusable-advisory"
    | "identity-mismatch"
    | "unsupported-definition"
    | "invalid-answer"
    | "invalid-currency"
    | "invalid-integrity"
    | "invalid-snapshot"
    | "invalid-provenance";
};
export type PolicyPreparationResult =
  | PolicyPreparationRefusal
  | {
      ok: true;
      value: {
        status: "evaluated";
        applied: false;
        rule: DefinitionRef;
        probability: number;
        comparison: ">=";
        threshold: number;
        matched: boolean;
        intent?: PreparedPolicyIntent;
      };
    };

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown) => count(v) && v > 0;
const hash = (v: unknown): v is string => typeof v === "string" && SHA256_RE.test(v);
const slug = (v: unknown) => text(v) && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(v);
const member = (v: unknown, values: readonly string[]) =>
  typeof v === "string" && values.includes(v);
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).length === expected.length && expected.every((key) => Object.hasOwn(v, key));
const copy = <T>(v: T): T => JSON.parse(canonicalJson(v)) as T;
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
function definition(v: unknown): boolean {
  return (
    record(v) &&
    keys(v, ["id", "version", "digest"]) &&
    slug(v.id) &&
    positive(v.version) &&
    hash(v.digest)
  );
}
function subject(v: unknown): boolean {
  if (!record(v)) return false;
  switch (v.kind) {
    case "run":
      return keys(v, ["kind", "runId"]) && text(v.runId);
    case "phase-attempt":
      return (
        keys(v, ["kind", "instanceId", "phaseId", "attempt"]) &&
        text(v.instanceId) &&
        text(v.phaseId) &&
        count(v.attempt)
      );
    case "rule-verification":
    case "acceptance-verification":
      return keys(v, ["kind", "verificationId"]) && text(v.verificationId);
    default:
      return false;
  }
}
function provider(v: unknown): boolean {
  return (
    record(v) &&
    keys(v, ["provider", "requestedModel", "reportedModel", "adapterVersion", "elicitation"]) &&
    member(v.provider, ["claude-cli", "codex-cli", "jev", "deterministic", "human", "mock"]) &&
    [v.requestedModel, v.reportedModel].every((x) => x === null || typeof x === "string") &&
    positive(v.adapterVersion) &&
    member(v.elicitation, ["native", "verbalized", "sampled", "rule", "label"])
  );
}
function validRule(v: unknown): boolean {
  if (
    !record(v) ||
    !keys(v, [
      "id",
      "version",
      "question",
      "projection",
      "provider",
      "targetAnswer",
      "comparison",
      "threshold",
      "effect",
    ])
  )
    return false;
  const answer = v.targetAnswer;
  return (
    slug(v.id) &&
    positive(v.version) &&
    definition(v.question) &&
    definition(v.projection) &&
    provider(v.provider) &&
    record(answer) &&
    answer.kind === "probability" &&
    ((answer.shape === "binary" &&
      keys(answer, ["kind", "shape", "event"]) &&
      answer.event === "p") ||
      (answer.shape === "choice" &&
        keys(answer, ["kind", "shape", "optionId"]) &&
        slug(answer.optionId))) &&
    v.comparison === ">=" &&
    typeof v.threshold === "number" &&
    v.threshold >= 0 &&
    v.threshold <= 1 &&
    member(v.effect, ["escalate", "flag", "withhold-auto-approval"])
  );
}
function assessment(v: unknown): v is DecisionAssessment {
  if (!record(v) || !record(v.snapshot)) return false;
  const numeric = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
  return (
    text(v.id) &&
    /^DA-[A-Za-z0-9_-]{6,80}$/.test(v.id) &&
    definition(v.question) &&
    subject(v.subject) &&
    definition(v.snapshot.projection) &&
    hash(v.snapshot.sha256) &&
    count(v.snapshot.bytes) &&
    provider(v.provider) &&
    count(v.sample) &&
    numeric(v.latencyMs) &&
    [v.tokens, v.costUsd].every((x) => x === null || numeric(x)) &&
    text(v.createdAt) &&
    member(v.mode, ["shadow", "advisory", "enforcing"]) &&
    record(v.outcome) &&
    (v.reEvaluates === undefined ||
      (text(v.reEvaluates) && /^DA-[A-Za-z0-9_-]{6,80}$/.test(v.reEvaluates)))
  );
}
function snapshotContent(v: unknown): boolean {
  if (!record(v) || !record(v.refs)) return false;
  const refs = v.refs;
  return (
    v.format === "argus.decision-snapshot" &&
    v.formatVersion === 1 &&
    definition(v.projection) &&
    subject(v.subject) &&
    Array.isArray(refs.runs) &&
    refs.runs.every(text) &&
    Array.isArray(refs.verifications) &&
    refs.verifications.every(text) &&
    Array.isArray(refs.claims) &&
    refs.claims.every((r) => record(r) && text(r.id) && positive(r.revision)) &&
    Array.isArray(refs.artifacts) &&
    refs.artifacts.every(
      (r) => record(r) && text(r.path) && member(r.location, ["repository", "artifact-dir"]),
    ) &&
    Array.isArray(v.subjectAuthored) &&
    v.subjectAuthored.every((p) => typeof p === "string") &&
    Array.isArray(v.redactions) &&
    v.redactions.every((r) => record(r) && text(r.rule) && count(r.count)) &&
    Array.isArray(v.truncations) &&
    v.truncations.every(
      (r) =>
        record(r) &&
        typeof r.pointer === "string" &&
        count(r.originalCodePoints) &&
        count(r.keptCodePoints) &&
        r.keptCodePoints <= r.originalCodePoints,
    ) &&
    Object.hasOwn(v, "body") &&
    (v.repository === undefined || record(v.repository))
  );
}

export function createPolicyPreparer(deps: {
  registry: Pick<DecisionRegistry, "question" | "projection" | "latestQuestion">;
}) {
  return {
    prepare(input: PolicyPreparationInput): PolicyPreparationResult {
      const refuse = (reason: PolicyPreparationRefusal["reason"]): PolicyPreparationRefusal =>
        freeze({ ok: false, reason });
      try {
        const raw: unknown = copy(input);
        if (!record(raw)) return refuse("malformed-input");
        if (!validRule(raw.rule)) return refuse("invalid-rule");
        if (
          !record(raw.target) ||
          !keys(raw.target, ["subject", "stateDigest"]) ||
          !subject(raw.target.subject) ||
          !hash(raw.target.stateDigest)
        )
          return refuse("invalid-target");
        if (!record(raw.advisory) || raw.advisory.ok !== true || !record(raw.advisory.value))
          return refuse("unusable-advisory");
        const advisory = raw.advisory.value;
        if (
          advisory.usable !== true ||
          advisory.presentation !== "current" ||
          advisory.authority !== "inference-only" ||
          !Array.isArray(advisory.reasons) ||
          advisory.reasons.length !== 0 ||
          !assessment(advisory.assessment)
        )
          return refuse("unusable-advisory");
        const req = raw as unknown as PolicyPreparationInput;
        const rule = req.rule;
        const a = advisory.assessment;
        if (
          !equal(a.question, rule.question) ||
          !equal(a.snapshot.projection, rule.projection) ||
          !equal(a.provider, rule.provider) ||
          !equal(a.subject, req.target.subject)
        )
          return refuse("identity-mismatch");
        const q = copy(deps.registry.question(rule.question.id, rule.question.version));
        const p = copy(deps.registry.projection(rule.projection.id, rule.projection.version));
        const latest = copy(deps.registry.latestQuestion(rule.question.id));
        if (
          !q ||
          !p ||
          !latest ||
          !equal(q.ref, rule.question) ||
          !equal(p.ref, rule.projection) ||
          !equal(latest.ref, q.ref) ||
          canonicalDigest(q.def).sha256 !== q.ref.digest ||
          canonicalDigest(p.def).sha256 !== p.ref.digest ||
          canonicalDigest(latest.def).sha256 !== latest.ref.digest ||
          q.def.id !== q.ref.id ||
          q.def.version !== q.ref.version ||
          p.def.id !== p.ref.id ||
          p.def.version !== p.ref.version ||
          q.def.subject !== a.subject.kind ||
          p.def.subject !== a.subject.kind ||
          q.def.projection.id !== p.ref.id ||
          q.def.projection.version !== p.ref.version ||
          !text(q.def.text) ||
          !Array.isArray(q.def.consumers) ||
          q.def.consumers.length !== 0 ||
          !positive(p.def.maxBytes) ||
          a.snapshot.bytes > p.def.maxBytes
        )
          return refuse("unsupported-definition");
        const space = q.def.answers;
        if (!record(space) || (space.shape !== "binary" && space.shape !== "choice"))
          return refuse("invalid-answer");
        if (
          space.shape === "choice" &&
          (!Array.isArray(space.options) ||
            space.options.length < 2 ||
            !space.options.every((o) => record(o) && slug(o.id) && text(o.label)) ||
            new Set(space.options.map((o) => o.id)).size !== space.options.length ||
            typeof space.sumTolerance !== "number" ||
            space.sumTolerance < 0 ||
            space.sumTolerance >= 0.5)
        )
          return refuse("invalid-answer");
        if (
          checkOutcome(space, a.outcome) ||
          a.outcome.status !== "answered" ||
          a.outcome.answer.kind !== "probability" ||
          space.shape !== rule.targetAnswer.shape ||
          a.outcome.answer.shape !== rule.targetAnswer.shape
        )
          return refuse("invalid-answer");
        if (rule.targetAnswer.shape === "choice") {
          const optionId = rule.targetAnswer.optionId;
          if (space.shape !== "choice" || !space.options.some((o) => o.id === optionId))
            return refuse("invalid-answer");
        }
        if (
          !record(advisory.integrity) ||
          !Array.isArray(advisory.integrity.gaps) ||
          advisory.integrity.gaps.length ||
          !Array.isArray(advisory.integrity.notices) ||
          !advisory.integrity.notices.every(
            (n) =>
              record(n) &&
              member(n.kind, ["torn-tail", "recovered-torn-write", "duplicate"]) &&
              typeof n.detail === "string" &&
              (n.segment === undefined || (text(n.segment) && /^seg-\d{8}$/.test(n.segment))) &&
              (n.line === undefined || positive(n.line)),
          )
        )
          return refuse("invalid-integrity");
        const retained = advisory.retained;
        if (
          !record(retained) ||
          retained.status !== "retained" ||
          !member(retained.store, ["active", "archive"]) ||
          !record(retained.snapshot) ||
          !snapshotContent(retained.snapshot.content)
        )
          return refuse("invalid-snapshot");
        const s = retained.snapshot;
        const content = s.content as Record<string, unknown>;
        const seal = canonicalDigest(content);
        if (
          seal.sha256 !== s.sha256 ||
          seal.bytes !== s.bytes ||
          seal.sha256 !== a.snapshot.sha256 ||
          seal.bytes !== a.snapshot.bytes ||
          !equal(content.subject, a.subject) ||
          !equal(content.projection, a.snapshot.projection)
        )
          return refuse("invalid-snapshot");
        const currency = advisory.currency;
        const expected = new Set([
          "question-definition",
          "question-version",
          "projection-definition",
          "snapshot",
          "subject",
        ]);
        if ((content.refs as { claims: unknown[] }).claims.length) expected.add("claim-revisions");
        if (content.repository !== undefined) expected.add("repository-state");
        if (
          !record(currency) ||
          currency.status !== "current" ||
          currency.assessmentId !== a.id ||
          !Array.isArray(currency.checks) ||
          currency.checks.length !== expected.size ||
          !currency.checks.every(
            (c) =>
              record(c) &&
              c.status === "current" &&
              typeof c.detail === "string" &&
              typeof c.check === "string" &&
              expected.delete(c.check),
          ) ||
          expected.size
        )
          return refuse("invalid-currency");
        const provenance = advisory.provenance;
        if (
          !record(provenance) ||
          !text(provenance.segment) ||
          !/^seg-\d{8}$/.test(provenance.segment) ||
          !positive(provenance.line) ||
          !hash(provenance.digest) ||
          canonicalDigest({ body: a, kind: "assessment" }).sha256 !== provenance.digest
        )
          return refuse("invalid-provenance");
        const probability =
          a.outcome.answer.shape === "binary"
            ? a.outcome.answer.p
            : a.outcome.answer.p[(rule.targetAnswer as { optionId: string }).optionId];
        const ruleRef = {
          id: rule.id,
          version: rule.version,
          digest: canonicalDigest(rule).sha256,
        };
        const matched = probability >= rule.threshold;
        const value: Extract<PolicyPreparationResult, { ok: true }>["value"] = {
          status: "evaluated",
          applied: false,
          rule: ruleRef,
          probability,
          comparison: rule.comparison,
          threshold: rule.threshold,
          matched,
        };
        if (matched) {
          const body = {
            status: "prepared" as const,
            applied: false as const,
            authority: "inference-only" as const,
            rule: ruleRef,
            assessmentId: a.id,
            assessmentDigest: provenance.digest,
            question: a.question,
            projection: a.snapshot.projection,
            provider: a.provider,
            sample: a.sample,
            snapshot: a.snapshot,
            subject: a.subject,
            target: req.target,
            targetAnswer: rule.targetAnswer,
            probability,
            comparison: rule.comparison,
            threshold: rule.threshold,
            effect: rule.effect,
          };
          value.intent = { ...body, digest: canonicalDigest(body).sha256 };
        }
        return freeze({ ok: true, value });
      } catch {
        return refuse("malformed-input");
      }
    },
  };
}
