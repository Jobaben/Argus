import type { DecisionQuestion, DecisionProjection, StoredSnapshot } from "@argus/contracts";
import { canonicalDigest, canonicalJson, sha256Hex, SHA256_RE } from "./canonical.js";
import { builtinRegistry } from "./definitions.js";
import type { DecisionJournal } from "./journal.js";
import {
  CLAUDE_CLI_ADAPTER_VERSION,
  DECISION_PROMPT_RENDERER_VERSION,
  renderDecisionPrompt,
} from "./providers/claudeCli.js";
import type { DecisionRegistry } from "./registry.js";
import type { DecisionService, ReEvaluationPreparation } from "./service.js";
import { encodeLine } from "./storage.js";

const definitions = builtinRegistry();
const question = definitions.question("run.termination-probe", 2)!;
const projection = definitions.projection("run-failure.blind", 2)!;
const renderer = Object.freeze({
  id: "claude-cli.decision-prompt",
  version: DECISION_PROMPT_RENDERER_VERSION,
  adapterVersion: CLAUDE_CLI_ADAPTER_VERSION,
});

export interface EvaluationInputArtifact {
  format: "argus.evaluation-input";
  formatVersion: 1;
  preparation: ReEvaluationPreparation;
  question: DecisionQuestion;
  projection: DecisionProjection;
  snapshot: StoredSnapshot;
  renderer: { id: string; version: number; adapterVersion: number };
  prompt: { text: string; sha256: string; bytes: number };
  dispatchable: false;
  digest: string;
}
export interface EvaluationInputAuditReceipt {
  format: "argus.evaluation-input-audit-receipt";
  formatVersion: 1;
  artifactDigest: string;
  protocol: { id: string; version: number; digest: string };
  reviewer: { provenance: "unauthenticated-reference"; reference: string };
  at: string;
  disposition: "reviewed-for-offline-use" | "withheld";
  digest: string;
}
export interface EvaluationInputDeps {
  service: Pick<DecisionService, "prepareReEvaluation">;
  journal: Pick<DecisionJournal, "read" | "loadSnapshot">;
  registry: Pick<DecisionRegistry, "question" | "projection">;
}
type Refusal = {
  ok: false;
  reason: "input-unavailable" | "invalid-artifact" | "receipt-unavailable";
  detail: string;
  dispatchable: false;
};
function refuse(reason: Refusal["reason"], detail: string): Refusal {
  return { ok: false, reason, detail, dispatchable: false };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function copy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function requireMatch(condition: boolean, detail: string): void {
  if (!condition) throw new Error(detail);
}
function validateArtifact(a: EvaluationInputArtifact): void {
  requireMatch(
    keys(a, [
      "format",
      "formatVersion",
      "preparation",
      "question",
      "projection",
      "snapshot",
      "renderer",
      "prompt",
      "dispatchable",
      "digest",
    ]),
    "artifact schema mismatch",
  );
  const { digest, ...body } = a;
  requireMatch(
    a.format === "argus.evaluation-input" && a.formatVersion === 1 && a.dispatchable === false,
    "unsupported artifact",
  );
  requireMatch(digest === canonicalDigest(body).sha256, "artifact digest mismatch");
  const p = a.preparation;
  requireMatch(
    keys(p, [
      "format",
      "formatVersion",
      "assessmentId",
      "parent",
      "question",
      "projection",
      "snapshot",
      "providerKey",
      "provider",
      "sample",
      "digest",
    ]),
    "preparation schema mismatch",
  );
  requireMatch(
    keys(p.parent, ["digest", "segment", "line"]) &&
      SHA256_RE.test(p.parent.digest) &&
      bounded(p.parent.segment) &&
      Number.isSafeInteger(p.parent.line) &&
      p.parent.line > 0,
    "parent provenance schema mismatch",
  );
  requireMatch(
    /^DA-[A-Za-z0-9_-]{6,80}$/.test(p.assessmentId) &&
      bounded(p.providerKey) &&
      Number.isSafeInteger(p.sample) &&
      p.sample >= 0,
    "preparation identity schema mismatch",
  );
  requireMatch(
    keys(p.provider, ["provider", "requestedModel", "adapterVersion", "elicitation"]) &&
      (p.provider.requestedModel === null || bounded(p.provider.requestedModel)),
    "provider schema mismatch",
  );
  requireMatch(
    keys(p.snapshot, ["sha256", "bytes", "subject"]) &&
      SHA256_RE.test(p.snapshot.sha256) &&
      Number.isSafeInteger(p.snapshot.bytes) &&
      p.snapshot.bytes > 0 &&
      keys(p.snapshot.subject, ["kind", "runId"]) &&
      p.snapshot.subject.kind === "run" &&
      bounded(p.snapshot.subject.runId),
    "snapshot identity schema mismatch",
  );
  requireMatch(
    keys(a.snapshot, ["sha256", "bytes", "content"]) && keys(a.prompt, ["text", "sha256", "bytes"]),
    "snapshot or prompt schema mismatch",
  );
  const { digest: preparationDigest, ...preparationBody } = p;
  requireMatch(
    p.format === "argus.retained-evaluation-preparation" &&
      p.formatVersion === 1 &&
      preparationDigest === canonicalDigest(preparationBody).sha256,
    "preparation digest mismatch",
  );
  requireMatch(
    same(p.question, question.ref) &&
      same(p.projection, projection.ref) &&
      same(a.question, question.def) &&
      same(a.projection, projection.def),
    "only exact registered V2 definitions are supported",
  );
  requireMatch(
    p.provider.provider === "claude-cli" &&
      p.provider.elicitation === "verbalized" &&
      p.provider.adapterVersion === CLAUDE_CLI_ADAPTER_VERSION,
    "unsupported renderer/provider identity",
  );
  requireMatch(same(a.renderer, renderer), "renderer identity mismatch");
  const sealed = canonicalDigest(a.snapshot.content);
  requireMatch(
    a.snapshot.content.format === "argus.decision-snapshot" &&
      a.snapshot.content.formatVersion === 1 &&
      sealed.sha256 === a.snapshot.sha256 &&
      sealed.bytes === a.snapshot.bytes &&
      sealed.bytes <= a.projection.maxBytes,
    "invalid retained content",
  );
  requireMatch(
    p.snapshot.sha256 === sealed.sha256 &&
      p.snapshot.bytes === sealed.bytes &&
      same(p.snapshot.subject, a.snapshot.content.subject) &&
      same(p.projection, a.snapshot.content.projection) &&
      a.snapshot.content.subject.kind === a.question.subject,
    "retained identity mismatch",
  );
  requireMatch(
    a.prompt.text === renderDecisionPrompt(a.question, a.snapshot) &&
      a.prompt.sha256 === sha256Hex(a.prompt.text) &&
      a.prompt.bytes === Buffer.byteLength(a.prompt.text, "utf8"),
    "exact rendered bytes mismatch",
  );
}

/** A fresh offline rendering of retained V2 evidence; never a historical dispatch assertion. */
export async function prepareEvaluationInput(
  deps: EvaluationInputDeps,
  request: { assessmentId: string; provider: string; sample?: number },
): Promise<{ ok: true; artifact: EvaluationInputArtifact } | Refusal> {
  try {
    const req = copy(request);
    const prepared = await deps.service.prepareReEvaluation(req);
    if (!prepared.ok) return refuse("input-unavailable", `${prepared.reason}: ${prepared.detail}`);
    const p = copy(prepared.preparation);
    requireMatch(
      p.assessmentId === req.assessmentId &&
        p.providerKey === req.provider &&
        p.sample === (req.sample ?? 0),
      "preparation request mismatch",
    );
    const q = deps.registry.question(p.question.id, p.question.version);
    const proj = deps.registry.projection(p.projection.id, p.projection.version);
    requireMatch(
      !!q && !!proj && same(q.ref, p.question) && same(proj.ref, p.projection),
      "registry identity mismatch",
    );
    const view = copy(await deps.journal.read());
    requireMatch(
      view.gaps.length === 0 &&
        view.notices.length === 0 &&
        view.segments.every((s) => s.integrity === "intact" || s.integrity === "open"),
      "journal integrity is incomplete",
    );
    const matches = view.entries.filter((e) => e.assessment.id === p.assessmentId);
    requireMatch(matches.length === 1, "parent provenance unavailable or ambiguous");
    const entry = matches[0];
    requireMatch(
      view.segments.filter((s) => s.segment === entry.segment).length === 1,
      "parent segment provenance unavailable or ambiguous",
    );
    requireMatch(
      same({ digest: entry.digest, segment: entry.segment, line: entry.line }, p.parent) &&
        encodeLine("assessment", entry.assessment).digest === entry.digest,
      "parent provenance mismatch",
    );
    requireMatch(
      same(entry.assessment.question, p.question) &&
        same(entry.assessment.subject, p.snapshot.subject) &&
        same(entry.assessment.snapshot, {
          sha256: p.snapshot.sha256,
          bytes: p.snapshot.bytes,
          projection: p.projection,
        }),
      "parent identity mismatch",
    );
    const retained = await deps.journal.loadSnapshot(p.snapshot.sha256);
    requireMatch(retained.status === "retained", "snapshot unavailable");
    if (retained.status !== "retained" || !q || !proj)
      return refuse("input-unavailable", "retained definitions unavailable");
    const snap = copy(retained.snapshot);
    const text = renderDecisionPrompt(q.def, snap);
    const body: Omit<EvaluationInputArtifact, "digest"> = {
      format: "argus.evaluation-input",
      formatVersion: 1,
      preparation: p,
      question: copy(q.def),
      projection: copy(proj.def),
      snapshot: snap,
      renderer: copy(renderer),
      prompt: { text, sha256: sha256Hex(text), bytes: Buffer.byteLength(text, "utf8") },
      dispatchable: false,
    };
    const artifact = { ...body, digest: canonicalDigest(body).sha256 };
    validateArtifact(artifact);
    return { ok: true, artifact: freeze(artifact) };
  } catch (e) {
    return refuse("input-unavailable", (e as Error).message);
  }
}
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    same(Object.keys(value).sort(), expected.sort())
  );
}
function bounded(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 500;
}
function validReceipt(value: unknown): value is EvaluationInputAuditReceipt {
  if (
    !keys(value, [
      "format",
      "formatVersion",
      "artifactDigest",
      "protocol",
      "reviewer",
      "at",
      "disposition",
      "digest",
    ])
  )
    return false;
  if (
    !keys(value.protocol, ["id", "version", "digest"]) ||
    !keys(value.reviewer, ["provenance", "reference"])
  )
    return false;
  return (
    value.format === "argus.evaluation-input-audit-receipt" &&
    value.formatVersion === 1 &&
    typeof value.artifactDigest === "string" &&
    SHA256_RE.test(value.artifactDigest) &&
    typeof value.digest === "string" &&
    SHA256_RE.test(value.digest) &&
    bounded(value.protocol.id) &&
    Number.isSafeInteger(value.protocol.version) &&
    (value.protocol.version as number) > 0 &&
    typeof value.protocol.digest === "string" &&
    SHA256_RE.test(value.protocol.digest) &&
    value.reviewer.provenance === "unauthenticated-reference" &&
    bounded(value.reviewer.reference) &&
    typeof value.at === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at) &&
    Number.isFinite(Date.parse(value.at)) &&
    new Date(value.at).toISOString() === value.at &&
    (value.disposition === "reviewed-for-offline-use" || value.disposition === "withheld")
  );
}

/** Records caller-supplied review completeness, without authenticating it or granting authority. */
export function bindEvaluationInputAudit(
  artifact: EvaluationInputArtifact,
  suppliedReceipt: unknown,
):
  | {
      ok: true;
      status: "offline-review-complete";
      dispatchable: false;
      artifact: EvaluationInputArtifact;
      receipt: EvaluationInputAuditReceipt;
    }
  | Refusal {
  try {
    const a = copy(artifact);
    try {
      validateArtifact(a);
    } catch (e) {
      return refuse("invalid-artifact", (e as Error).message);
    }
    const r = copy(suppliedReceipt);
    if (!validReceipt(r))
      return refuse("receipt-unavailable", "an explicit closed audit receipt is required");
    const { digest, ...body } = r;
    if (
      digest !== canonicalDigest(body).sha256 ||
      r.artifactDigest !== a.digest ||
      r.disposition !== "reviewed-for-offline-use"
    )
      return refuse("receipt-unavailable", "receipt digest, artifact or disposition mismatch");
    return freeze({
      ok: true as const,
      status: "offline-review-complete" as const,
      dispatchable: false as const,
      artifact: a,
      receipt: r,
    });
  } catch (e) {
    return refuse("receipt-unavailable", (e as Error).message);
  }
}
