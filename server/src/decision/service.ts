import { randomBytes } from "node:crypto";
import type {
  DecisionAssessment,
  DecisionOutcome,
  DecisionQuestion,
  DecisionSubject,
  DefinitionRef,
  ProviderIdentity,
  StoredSnapshot,
} from "@argus/contracts";
import { checkOutcome } from "./answers.js";
import { canonicalDigest } from "./canonical.js";
import { ASSESSMENT_ID_RE, DecisionJournal, JournalError, type AppendResult } from "./journal.js";
import { buildSnapshot, type DecisionSources, type ProjectionBuilder } from "./projection.js";
import type { DecisionProvider, DispatchAdmission, ProviderResponse } from "./providers/types.js";
import type { DecisionRegistry } from "./registry.js";

/**
 * The Decision service: build a snapshot, ask a provider, append the answer
 * (RFC §G.1, §F.3). It is isolated from the rest of Argus (§O). Nothing
 * imports it at startup, it registers no watcher, it has no engine hook, it
 * writes only its own journal, and every record it writes is
 * `mode: "shadow"`.
 *
 * Every failure before the provider call returns without calling it. That
 * covers an unknown question, a subject of the wrong kind, an unsupported
 * provider, a snapshot that cannot be built, and storage that refuses the
 * snapshot. `providerCalled` says so on every result, so a caller can tell a
 * spent call from a refused one.
 */

export type ServiceRefusal =
  | "unknown-question"
  | "definition-mismatch"
  | "subject-mismatch"
  | "unknown-provider"
  | "unsupported"
  | "snapshot-unbuildable"
  | "snapshot-unavailable"
  | "unknown-assessment"
  | "invalid-id"
  | "invalid-sample"
  | "preparation-mismatch"
  | "dispatch-refused"
  | "disabled"
  | "busy"
  | "budget-blocked"
  | "aborted"
  | "unsafe-cwd"
  | "storage-refused";

export type ServiceResult =
  | { ok: true; assessment: DecisionAssessment; append: AppendResult; providerCalled: true }
  | { ok: false; reason: ServiceRefusal; detail: string; providerCalled: boolean };

export interface ReEvaluationPreparation {
  format: "argus.retained-evaluation-preparation";
  formatVersion: 1;
  assessmentId: string;
  parent: { digest: string; segment: string; line: number };
  question: DefinitionRef;
  projection: DefinitionRef;
  snapshot: { sha256: string; bytes: number; subject: DecisionSubject };
  providerKey: string;
  provider: Omit<ProviderIdentity, "reportedModel">;
  sample: number;
  digest: string;
}

export type ReEvaluationPreparationResult =
  { ok: true; preparation: ReEvaluationPreparation } | Extract<ServiceResult, { ok: false }>;

export interface DecisionServiceDeps {
  journal: DecisionJournal;
  registry: DecisionRegistry;
  builders: readonly ProjectionBuilder[];
  sources: DecisionSources;
  providers: Readonly<Record<string, DecisionProvider>>;
  now?: () => Date;
  newId?: () => string;
}

export interface DecisionService {
  assess(req: {
    question: string;
    version?: number;
    subject: DecisionSubject;
    provider: string;
    sample?: number;
    signal?: AbortSignal;
    /**
     * A pre-assigned assessment id. A caller that records its intent before
     * the call (the H2 watcher, §P.5) names the id up front, so that after a
     * crash it can tell whether the assessment reached the journal.
     */
    id?: string;
  }): Promise<ServiceResult>;
  /**
   * A call on a snapshot the caller captured earlier with the question's own
   * registered projection (the H1 watcher, §Q.3): the provider is sent what
   * was captured, never a snapshot rebuilt at call time. The snapshot is
   * re-sealed and must match its digest, the question's projection by digest
   * and the subject; then it is published before the call, as always.
   */
  assessSnapshot(req: {
    question: string;
    version: number;
    snapshot: StoredSnapshot;
    provider: string;
    sample?: number;
    signal?: AbortSignal;
    id?: string;
  }): Promise<ServiceResult>;
  prepareReEvaluation(req: {
    assessmentId: string;
    provider: string;
    sample?: number;
  }): Promise<ReEvaluationPreparationResult>;
  /** A NEW provider call on the retained snapshot and original question version of `assessmentId`. */
  reEvaluate(req: {
    assessmentId: string;
    provider: string;
    sample?: number;
    signal?: AbortSignal;
    id?: string;
    expectedPreparationDigest?: string;
    beforeProviderCall?: DispatchAdmission;
  }): Promise<ServiceResult>;
}

/** Cap every free-text field, so a record stays far below the journal's record limit. */
function boundText(o: DecisionOutcome): DecisionOutcome {
  const cap = (s: string, max: number) => {
    const cps = Array.from(s);
    return cps.length > max ? cps.slice(0, max).join("") : s;
  };
  switch (o.status) {
    case "answered":
      return o.rationale === undefined ? o : { ...o, rationale: cap(o.rationale, 2000) };
    case "abstained":
      return { ...o, reason: cap(o.reason, 1000) };
    case "failed":
      return {
        ...o,
        failure: cap(o.failure, 100),
        detail: cap(o.detail, 1000),
        ...(o.rawExcerpt === undefined ? {} : { rawExcerpt: cap(o.rawExcerpt, 2000) }),
      };
  }
}

const refuse = (
  reason: ServiceRefusal,
  detail: string,
  providerCalled = false,
): Extract<ServiceResult, { ok: false }> => ({
  ok: false,
  reason,
  detail,
  providerCalled,
});

const NO_CALL_GUARDS: ReadonlySet<string> = new Set([
  "disabled",
  "busy",
  "budget-blocked",
  "aborted",
  "unsafe-cwd",
  "dispatch-refused",
]);

function provenNoCall(response: ProviderResponse, provider: DecisionProvider): boolean {
  if (response.executionDisposition !== "not-called") return false;
  const identity = response.identity;
  const registered = provider.identity();
  const zeroOrUnknown = (value: unknown) => value === null || value === 0;
  return (
    response.executionDisposition === "not-called" &&
    identity?.provider === provider.kind &&
    identity.provider === registered.provider &&
    (identity.requestedModel === null || typeof identity.requestedModel === "string") &&
    identity.requestedModel === registered.requestedModel &&
    identity.reportedModel === null &&
    Number.isSafeInteger(identity.adapterVersion) &&
    identity.adapterVersion > 0 &&
    identity.adapterVersion === registered.adapterVersion &&
    ["native", "verbalized", "sampled", "rule", "label"].includes(identity.elicitation) &&
    identity.elicitation === registered.elicitation &&
    response.outcome?.status === "failed" &&
    NO_CALL_GUARDS.has(response.outcome.failure) &&
    typeof response.outcome.detail === "string" &&
    response.outcome.rawExcerpt === undefined &&
    zeroOrUnknown(response.costUsd) &&
    zeroOrUnknown(response.tokens)
  );
}

function completeSubject(value: unknown): value is DecisionSubject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const subject = value as Record<string, unknown>;
  const identity = (id: unknown) => typeof id === "string" && id.trim().length > 0;
  switch (subject.kind) {
    case "run":
      return identity(subject.runId);
    case "phase-attempt":
      return (
        identity(subject.instanceId) &&
        identity(subject.phaseId) &&
        Number.isSafeInteger(subject.attempt) &&
        (subject.attempt as number) >= 0
      );
    case "rule-verification":
    case "acceptance-verification":
      return identity(subject.verificationId);
    default:
      return false;
  }
}

export function createDecisionService(deps: DecisionServiceDeps): DecisionService {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => `DA-${randomBytes(12).toString("base64url")}`);

  /** Call the provider and turn anything it does into an honest, validated outcome. */
  async function call(
    provider: DecisionProvider,
    q: DecisionQuestion,
    snapshot: StoredSnapshot,
    signal: AbortSignal,
    admission?: DispatchAdmission,
  ): Promise<
    { response: ProviderResponse; latencyMs: number } | Extract<ServiceResult, { ok: false }>
  > {
    if (admission && typeof provider.assessWithAdmission !== "function")
      return refuse("dispatch-refused", "provider does not support guarded dispatch");
    const started = now().getTime();
    let response: ProviderResponse;
    try {
      response = admission
        ? await provider.assessWithAdmission!(q, snapshot, signal, admission)
        : await provider.assess(q, snapshot, signal);
    } catch (e) {
      response = {
        identity: provider.identity(),
        outcome: {
          status: "failed",
          failure: "provider-error",
          detail: (e as Error).message ?? String(e),
        },
        costUsd: null,
        tokens: null,
      };
    }
    const latencyMs = Math.max(0, now().getTime() - started);
    if (provenNoCall(response, provider)) {
      const outcome = boundText(response.outcome);
      if (outcome.status === "failed")
        return refuse(outcome.failure as ServiceRefusal, outcome.detail);
    }
    const invalidDisposition =
      response.executionDisposition !== undefined &&
      response.executionDisposition !== "possibly-called";
    let outcome: DecisionOutcome = response.outcome;
    if (invalidDisposition) {
      outcome = {
        status: "failed",
        failure: "invalid-execution-disposition",
        detail: "the provider response does not prove that execution was refused before a call",
      };
      response = { ...response, identity: provider.identity() };
    }
    // An identity that is not the provider's own kind cannot be recorded as
    // that provider's answer.
    if (response.identity?.provider !== provider.kind) {
      if (!invalidDisposition)
        outcome = {
          status: "failed",
          failure: "identity-mismatch",
          detail: `a ${provider.kind} provider reported identity ${String(response.identity?.provider)}`,
        };
      response = { ...response, identity: { ...response.identity, provider: provider.kind } };
    }
    // Re-validate whatever the provider claims, mocks included.
    const bad = checkOutcome(q.answers, outcome);
    if (bad) outcome = { status: "failed", failure: "invalid-answer", detail: bad };
    const stats = outcome.status === "answered" ? outcome.providerStatistics : undefined;
    if (
      stats &&
      (Object.keys(stats).length > 32 || Object.keys(stats).some((k) => k.length > 100))
    ) {
      outcome = {
        status: "failed",
        failure: "invalid-answer",
        detail: "too many provider statistics",
      };
    }
    outcome = boundText(outcome);
    const finite = (n: number | null) =>
      typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
    return {
      response: {
        ...response,
        outcome,
        costUsd: finite(response.costUsd),
        tokens: finite(response.tokens),
      },
      latencyMs,
    };
  }

  async function record(
    q: { ref: DefinitionRef },
    subject: DecisionSubject,
    snapshot: StoredSnapshot,
    provider: DecisionProvider,
    def: DecisionQuestion,
    sample: number,
    signal: AbortSignal,
    reEvaluates?: string,
    id?: string,
    admission?: DispatchAdmission,
  ): Promise<ServiceResult> {
    const called = await call(provider, def, snapshot, signal, admission);
    if ("ok" in called) return called;
    const { response, latencyMs } = called;
    const assessment: DecisionAssessment = {
      id: id ?? newId(),
      question: q.ref,
      subject,
      snapshot: {
        sha256: snapshot.sha256,
        bytes: snapshot.bytes,
        projection: snapshot.content.projection,
      },
      provider: response.identity,
      sample,
      ...(reEvaluates ? { reEvaluates } : {}),
      outcome: response.outcome,
      mode: "shadow",
      latencyMs,
      costUsd: response.costUsd,
      tokens: response.tokens,
      createdAt: now().toISOString(),
    };
    try {
      const append = await deps.journal.append(assessment, snapshot);
      return { ok: true, assessment, append, providerCalled: true };
    } catch (e) {
      if (e instanceof JournalError)
        return refuse("storage-refused", `${e.code}: ${e.message}`, true);
      throw e;
    }
  }

  function providerFor(
    key: string,
    q: DecisionQuestion,
  ): DecisionProvider | Extract<ServiceResult, { ok: false }> {
    const provider = deps.providers[key];
    if (!provider) return refuse("unknown-provider", `no provider "${key}"`);
    if (!provider.supports(q))
      return refuse("unsupported", `${key} does not answer ${q.id}@${q.version}`);
    return provider;
  }

  async function prepare(req: { assessmentId: string; provider: string; sample?: number }) {
    if (!ASSESSMENT_ID_RE.test(req.assessmentId))
      return refuse("invalid-id", "the parent is not an assessment id");
    const sample = req.sample ?? 0;
    if (!Number.isSafeInteger(sample) || sample < 0)
      return refuse("invalid-sample", "sample must be a nonnegative safe integer");
    const view = await deps.journal.read();
    const entry = view.entries.find((e) => e.assessment.id === req.assessmentId);
    const original = entry?.assessment;
    if (!original)
      return refuse("unknown-assessment", `no assessment ${req.assessmentId} in the journal`);
    const found = deps.registry.question(original.question.id, original.question.version);
    if (!found) {
      return refuse(
        "unknown-question",
        `${original.question.id}@${original.question.version} is not registered`,
      );
    }
    if (found.ref.digest !== original.question.digest) {
      return refuse(
        "definition-mismatch",
        `${original.question.id}@${original.question.version} differs from the definition the original used`,
      );
    }
    const provider = providerFor(req.provider, found.def);
    if ("ok" in provider) return provider;
    const lookup = await deps.journal.loadSnapshot(original.snapshot.sha256);
    if (lookup.status !== "retained") {
      return refuse(
        "snapshot-unavailable",
        `snapshot ${original.snapshot.sha256} is ${lookup.status}; the original cannot be re-evaluated`,
      );
    }
    const snapshot = lookup.snapshot;
    const projection = deps.registry.projection(
      found.def.projection.id,
      found.def.projection.version,
    );
    if (!projection)
      return refuse("definition-mismatch", "the original projection is not registered");
    try {
      const expectedProjection = canonicalDigest(projection.ref).text;
      if (
        canonicalDigest(original.snapshot.projection).text !== expectedProjection ||
        canonicalDigest(snapshot.content.projection).text !== expectedProjection
      ) {
        return refuse(
          "definition-mismatch",
          "the parent and retained snapshot must name the original registered projection",
        );
      }
      if (
        snapshot.content.format !== "argus.decision-snapshot" ||
        snapshot.content.formatVersion !== 1
      ) {
        return refuse("snapshot-unbuildable", "the retained snapshot format is unsupported");
      }
      if (
        !completeSubject(original.subject) ||
        !completeSubject(snapshot.content.subject) ||
        original.subject.kind !== found.def.subject ||
        snapshot.content.subject.kind !== found.def.subject ||
        canonicalDigest(original.subject).text !== canonicalDigest(snapshot.content.subject).text
      ) {
        return refuse(
          "subject-mismatch",
          "the parent and retained snapshot must name the same question subject",
        );
      }
      const sealed = canonicalDigest(snapshot.content);
      if (
        sealed.sha256 !== snapshot.sha256 ||
        sealed.bytes !== snapshot.bytes ||
        snapshot.sha256 !== original.snapshot.sha256 ||
        snapshot.bytes !== original.snapshot.bytes
      ) {
        return refuse(
          "snapshot-unbuildable",
          "the retained snapshot does not match the parent's hash and bytes",
        );
      }
      if (sealed.bytes > projection.def.maxBytes) {
        return refuse("snapshot-unbuildable", `too-large: ${sealed.bytes} bytes`);
      }
    } catch (e) {
      return refuse("snapshot-unbuildable", `invalid retained snapshot: ${(e as Error).message}`);
    }
    const identity = provider.identity();
    const binding: Omit<ReEvaluationPreparation, "digest"> = structuredClone({
      format: "argus.retained-evaluation-preparation",
      formatVersion: 1,
      assessmentId: original.id,
      parent: { digest: entry!.digest, segment: entry!.segment, line: entry!.line },
      question: found.ref,
      projection: projection.ref,
      snapshot: { sha256: snapshot.sha256, bytes: snapshot.bytes, subject: original.subject },
      providerKey: req.provider,
      provider: {
        provider: identity.provider,
        requestedModel: identity.requestedModel,
        adapterVersion: identity.adapterVersion,
        elicitation: identity.elicitation,
      },
      sample,
    });
    return {
      ok: true as const,
      preparation: { ...binding, digest: canonicalDigest(binding).sha256 },
      found,
      original,
      snapshot,
      provider,
      view,
    };
  }

  return {
    async assess(req) {
      const found =
        req.version === undefined
          ? deps.registry.latestQuestion(req.question)
          : deps.registry.question(req.question, req.version);
      if (!found) return refuse("unknown-question", `${req.question}@${req.version ?? "latest"}`);
      if (req.id !== undefined && !ASSESSMENT_ID_RE.test(req.id)) {
        return refuse("invalid-id", `"${req.id}" is not an assessment id`);
      }
      const q = found.def;
      if (req.subject.kind !== q.subject) {
        return refuse(
          "subject-mismatch",
          `${q.id} is about a ${q.subject}, not a ${req.subject.kind}`,
        );
      }
      const provider = providerFor(req.provider, q);
      if ("ok" in provider) return provider;
      const projection = deps.registry.projection(q.projection.id, q.projection.version);
      const builder = deps.builders.find(
        (b) => b.id === q.projection.id && b.version === q.projection.version,
      );
      if (!projection || !builder) {
        return refuse(
          "snapshot-unbuildable",
          `no builder for ${q.projection.id}@${q.projection.version}`,
        );
      }
      const built = await buildSnapshot(
        builder,
        projection.ref,
        projection.def,
        req.subject,
        deps.sources,
      );
      if (!built.ok) return refuse("snapshot-unbuildable", `${built.reason}: ${built.detail}`);
      // Hash before send: the exact input is durable before any provider sees it.
      try {
        await deps.journal.publishSnapshot(built.snapshot);
      } catch (e) {
        if (e instanceof JournalError) return refuse("storage-refused", `${e.code}: ${e.message}`);
        throw e;
      }
      return record(
        found,
        req.subject,
        built.snapshot,
        provider,
        q,
        req.sample ?? 0,
        req.signal ?? new AbortController().signal,
        undefined,
        req.id,
      );
    },

    async assessSnapshot(req) {
      const found = deps.registry.question(req.question, req.version);
      if (!found) return refuse("unknown-question", `${req.question}@${req.version}`);
      if (req.id !== undefined && !ASSESSMENT_ID_RE.test(req.id)) {
        return refuse("invalid-id", `"${req.id}" is not an assessment id`);
      }
      const q = found.def;
      const snapshot = req.snapshot;
      if (snapshot.content.subject.kind !== q.subject) {
        return refuse(
          "subject-mismatch",
          `${q.id} is about a ${q.subject}, not a ${snapshot.content.subject.kind}`,
        );
      }
      const provider = providerFor(req.provider, q);
      if ("ok" in provider) return provider;
      const projection = deps.registry.projection(q.projection.id, q.projection.version);
      const stamped = snapshot.content.projection;
      if (
        !projection ||
        stamped.id !== projection.ref.id ||
        stamped.version !== projection.ref.version ||
        stamped.digest !== projection.ref.digest
      ) {
        return refuse(
          "definition-mismatch",
          `the snapshot was not built by ${q.projection.id}@${q.projection.version} as registered`,
        );
      }
      let sealed: { sha256: string; bytes: number };
      try {
        sealed = canonicalDigest(snapshot.content);
      } catch (e) {
        return refuse("snapshot-unbuildable", `not-canonical: ${(e as Error).message}`);
      }
      if (sealed.sha256 !== snapshot.sha256 || sealed.bytes !== snapshot.bytes) {
        return refuse("snapshot-unbuildable", "the snapshot does not match its digest");
      }
      if (sealed.bytes > projection.def.maxBytes) {
        return refuse("snapshot-unbuildable", `too-large: ${sealed.bytes} bytes`);
      }
      try {
        await deps.journal.publishSnapshot(snapshot);
      } catch (e) {
        if (e instanceof JournalError) return refuse("storage-refused", `${e.code}: ${e.message}`);
        throw e;
      }
      return record(
        found,
        snapshot.content.subject,
        snapshot,
        provider,
        q,
        req.sample ?? 0,
        req.signal ?? new AbortController().signal,
        undefined,
        req.id,
      );
    },

    async prepareReEvaluation(req) {
      const prepared = await prepare(req);
      return prepared.ok ? { ok: true, preparation: prepared.preparation } : prepared;
    },

    async reEvaluate(req) {
      if (req.id !== undefined && !ASSESSMENT_ID_RE.test(req.id))
        return refuse("invalid-id", "the result is not an assessment id");
      if (
        req.expectedPreparationDigest !== undefined &&
        !/^[a-f0-9]{64}$/.test(req.expectedPreparationDigest)
      )
        return refuse("preparation-mismatch", "the expected preparation digest is invalid");
      const prepared = await prepare(req);
      if (!prepared.ok) return prepared;
      if (
        req.expectedPreparationDigest !== undefined &&
        req.expectedPreparationDigest !== prepared.preparation.digest
      )
        return refuse(
          "preparation-mismatch",
          "the retained evaluation binding changed since preparation",
        );
      const id = req.id ?? newId();
      if (!ASSESSMENT_ID_RE.test(id))
        return refuse("invalid-id", "the result is not an assessment id");
      if (prepared.view.entries.some((e) => e.assessment.id === id))
        return refuse("storage-refused", "the result assessment id already exists");
      const { found, original, snapshot, provider } = prepared;
      return record(
        found,
        original.subject,
        snapshot,
        provider,
        found.def,
        prepared.preparation.sample,
        req.signal ?? new AbortController().signal,
        original.id,
        id,
        req.beforeProviderCall,
      );
    },
  };
}
