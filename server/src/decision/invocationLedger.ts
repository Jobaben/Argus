import path from "node:path";
import type { ProviderIdentity } from "@argus/contracts";
import { KeyedMutex } from "../mutex.js";
import { canonicalDigest, canonicalJson, SHA256_RE } from "./canonical.js";
import { ASSESSMENT_ID_RE } from "./journal.js";
import type { ReEvaluationPreparation } from "./service.js";
import { appendLines, encodeLine, parseLines, readText, type WriteFn } from "./storage.js";

export interface AuthorizationGrant {
  reference: string;
  digest: string;
  principal: string;
  scope: string;
  issuedAt: string;
  expiresAt: string;
  invocationId: string;
  requestDigest: string;
  reportedModels: string[] | null;
}
export interface PreflightEvidence {
  reference: string;
  digest: string;
  invocationId: string;
  requestDigest: string;
  expiresAt: string;
}
export interface Ownership {
  identity: string;
  fence: string;
  expiresAt: string;
  ledgerFile: string;
  scope: string;
  policyDigest: string;
}
export interface Reservation {
  id: string;
  invocationId: string;
  requestDigest: string;
  scope: string;
  policyDigest: string;
  allowanceUsd: number;
}
export interface InvocationIntent {
  format: "argus.evaluation-intent";
  formatVersion: 1;
  invocationId: string;
  namespace: string;
  key: string;
  requestDigest: string;
  resultId: string;
  preparation: ReEvaluationPreparation;
  authorization: AuthorizationGrant;
  preflight: PreflightEvidence;
  owner: Ownership;
  reservation: Reservation;
  createdAt: string;
}
export interface InvocationSettlement {
  invocationId: string;
  intentDigest: string;
  state: "recorded" | "refused-before-call" | "unknown-outcome" | "integrity-halt";
  resultId: string;
  resultDigest: string | null;
  actualProvider: ProviderIdentity | null;
  outcome: "answered" | "failed" | "abstained" | null;
  providerCalled: "yes" | "no" | "unknown";
  costUsd: number | null;
  reason: string;
  at: string;
}
export interface LedgerState {
  intents: Map<string, { intent: InvocationIntent; digest: string }>;
  settlements: Map<string, InvocationSettlement>;
  callers: Map<string, string>;
  resultIds: Set<string>;
  bytes: number;
  sequence: number;
  previous: string | null;
}
export const TERMINAL_RESERVE_BYTES = 16384;
const INTENT_LIMIT = 32768;
const mutex = new KeyedMutex();
export const callerKey = (namespace: string, key: string) => canonicalJson([namespace, key]);
export class InvocationLedgerError extends Error {}
function invalid(reason: string): never {
  throw new InvocationLedgerError(`integrity: ${reason}`);
}
type Validator = (v: unknown) => void;
export const text: Validator = (v) => {
  if (typeof v !== "string" || v.length < 1 || v.length > 256) invalid("bounded string");
};
const reasonText: Validator = (v) => {
  if (typeof v !== "string" || v.length > 2000) invalid("reason");
};
export const digest: Validator = (v) => {
  if (typeof v !== "string" || !SHA256_RE.test(v)) invalid("digest");
};
const integer: Validator = (v) => {
  if (!Number.isSafeInteger(v) || Number(v) < 0) invalid("integer");
};
const positive: Validator = (v) => {
  integer(v);
  if (Number(v) < 1) invalid("positive integer");
};
export const quantity: Validator = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || Object.is(v, -0))
    invalid("quantity");
};
export const date: Validator = (v) => {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    invalid("date");
};
const nullable =
  (check: Validator): Validator =>
  (v) => {
    if (v !== null) check(v);
  };
const literal =
  (...values: unknown[]): Validator =>
  (v) => {
    if (!values.includes(v)) invalid("enum");
  };
export function closed(v: unknown, schema: Record<string, Validator>): void {
  canonicalJson(v);
  if (!v || typeof v !== "object" || Array.isArray(v)) invalid("object");
  const obj = v as Record<string, unknown>;
  if (
    Object.keys(obj).length !== Object.keys(schema).length ||
    Object.keys(obj).some((k) => !(k in schema))
  )
    invalid("closed schema");
  for (const [key, check] of Object.entries(schema)) check(obj[key]);
}
const ref: Validator = (v) => closed(v, { id: text, version: positive, digest });
const providerSchema = {
  provider: literal("claude-cli", "codex-cli", "jev", "deterministic", "human", "mock"),
  requestedModel: nullable(text),
  adapterVersion: positive,
  elicitation: literal("native", "verbalized", "sampled", "rule", "label"),
};
const provider: Validator = (v) => closed(v, providerSchema);
const actualProvider: Validator = (v) =>
  closed(v, { ...providerSchema, reportedModel: nullable(text) });
const subject: Validator = (v) => {
  const kind = (v as { kind?: unknown })?.kind;
  if (kind === "run") closed(v, { kind: literal("run"), runId: text });
  else if (kind === "phase-attempt")
    closed(v, {
      kind: literal("phase-attempt"),
      instanceId: text,
      phaseId: text,
      attempt: integer,
    });
  else if (kind === "rule-verification" || kind === "acceptance-verification")
    closed(v, { kind: literal(kind), verificationId: text });
  else invalid("subject");
};
const assessmentId: Validator = (v) => {
  if (typeof v !== "string" || !ASSESSMENT_ID_RE.test(v)) invalid("assessment id");
};
export function validatePreparation(v: unknown): void {
  closed(v, {
    format: literal("argus.retained-evaluation-preparation"),
    formatVersion: literal(1),
    assessmentId,
    parent: (p) =>
      closed(p, {
        digest,
        segment: (s) => {
          if (typeof s !== "string" || !/^seg-\d{8}$/.test(s)) invalid("segment");
        },
        line: positive,
      }),
    question: ref,
    projection: ref,
    snapshot: (s) => closed(s, { sha256: digest, bytes: positive, subject }),
    providerKey: text,
    provider,
    sample: integer,
    digest,
  });
  const { digest: bound, ...rest } = v as ReEvaluationPreparation;
  if (canonicalDigest(rest).sha256 !== bound) invalid("preparation digest");
}
export const validateAuthorization: Validator = (v) =>
  closed(v, {
    reference: text,
    digest,
    principal: text,
    scope: text,
    issuedAt: date,
    expiresAt: date,
    invocationId: text,
    requestDigest: digest,
    reportedModels: (models) => {
      if (models === null) return;
      if (
        !Array.isArray(models) ||
        models.length < 1 ||
        models.length > 32 ||
        new Set(models).size !== models.length
      )
        invalid("model allowlist");
      for (const m of models) text(m);
    },
  });
export const validatePreflight: Validator = (v) =>
  closed(v, {
    reference: text,
    digest,
    invocationId: text,
    requestDigest: digest,
    expiresAt: date,
  });
export const validateOwner: Validator = (v) =>
  closed(v, {
    identity: text,
    fence: text,
    expiresAt: date,
    ledgerFile: text,
    scope: text,
    policyDigest: digest,
  });
export const validateReservation: Validator = (v) =>
  closed(v, {
    id: text,
    invocationId: text,
    requestDigest: digest,
    scope: text,
    policyDigest: digest,
    allowanceUsd: quantity,
  });
export function boundRequestDigest(i: InvocationIntent): string {
  return canonicalDigest({
    request: {
      namespace: i.namespace,
      key: i.key,
      assessmentId: i.preparation.assessmentId,
      provider: i.preparation.providerKey,
      sample: i.preparation.sample,
      scope: i.reservation.scope,
      policyDigest: i.reservation.policyDigest,
      allowanceUsd: i.reservation.allowanceUsd,
    },
    preparationDigest: i.preparation.digest,
  }).sha256;
}
export function validateIntent(v: unknown): void {
  closed(v, {
    format: literal("argus.evaluation-intent"),
    formatVersion: literal(1),
    invocationId: text,
    namespace: text,
    key: text,
    requestDigest: digest,
    resultId: assessmentId,
    preparation: validatePreparation,
    authorization: validateAuthorization,
    preflight: validatePreflight,
    owner: validateOwner,
    reservation: validateReservation,
    createdAt: date,
  });
  const i = v as InvocationIntent;
  if (i.requestDigest !== boundRequestDigest(i)) invalid("request digest binding");
  if (i.resultId === i.preparation.assessmentId) invalid("result equals parent");
  for (const e of [i.authorization, i.preflight, i.reservation])
    if (e.invocationId !== i.invocationId || e.requestDigest !== i.requestDigest)
      invalid("evidence binding");
  if (
    i.authorization.scope !== i.reservation.scope ||
    i.owner.scope !== i.reservation.scope ||
    i.owner.policyDigest !== i.reservation.policyDigest
  )
    invalid("scope binding");
  if (
    Date.parse(i.authorization.issuedAt) > Date.parse(i.createdAt) ||
    [i.authorization, i.preflight, i.owner].some(
      (e) => Date.parse(e.expiresAt) <= Date.parse(i.createdAt),
    )
  )
    invalid("expired admission");
}
export function validateSettlement(v: unknown): void {
  closed(v, {
    invocationId: text,
    intentDigest: digest,
    state: literal("recorded", "refused-before-call", "unknown-outcome", "integrity-halt"),
    resultId: assessmentId,
    resultDigest: nullable(digest),
    actualProvider: nullable(actualProvider),
    outcome: nullable(literal("answered", "failed", "abstained")),
    providerCalled: literal("yes", "no", "unknown"),
    costUsd: nullable(quantity),
    reason: reasonText,
    at: date,
  });
  const s = v as InvocationSettlement;
  if ((s.state === "unknown-outcome" || s.state === "integrity-halt") && s.providerCalled === "no")
    invalid("uncertain no-call claim");
  if (
    s.state === "recorded" &&
    (s.resultDigest === null ||
      (s.actualProvider === null && s.outcome !== "failed") ||
      s.outcome === null ||
      s.providerCalled !== "yes")
  )
    invalid("recorded settlement");
  if (
    s.state === "refused-before-call" &&
    (s.providerCalled !== "no" ||
      s.costUsd !== 0 ||
      s.resultDigest !== null ||
      s.outcome !== null ||
      s.actualProvider !== null)
  )
    invalid("no-call settlement");
  if (
    s.state === "unknown-outcome" &&
    (s.costUsd !== null ||
      s.resultDigest !== null ||
      s.actualProvider !== null ||
      s.outcome !== null)
  )
    invalid("uncertain settlement");
  if (
    s.state === "integrity-halt" &&
    (s.actualProvider !== null ||
      (s.resultDigest !== null && (s.outcome !== "failed" || s.providerCalled !== "yes")) ||
      (s.resultDigest === null && (s.outcome !== null || s.costUsd !== null)))
  )
    invalid("integrity settlement");
}
export class InvocationLedger {
  readonly file: string;
  readonly maxBytes: number;
  readonly maxRecords: number;
  constructor(
    private readonly options: {
      file: string;
      requireOwnership: () => Promise<void>;
      maxBytes?: number;
      maxRecords?: number;
      write?: WriteFn;
    },
  ) {
    this.file = path.resolve(options.file);
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.maxRecords = options.maxRecords ?? 10000;
    positive(this.maxBytes);
    positive(this.maxRecords);
    if (typeof options.requireOwnership !== "function") invalid("ownership prerequisite");
  }
  async load(): Promise<LedgerState> {
    const raw = (await readText(this.file)) ?? "";
    const state: LedgerState = {
      intents: new Map(),
      settlements: new Map(),
      callers: new Map(),
      resultIds: new Set(),
      bytes: Buffer.byteLength(raw),
      sequence: 0,
      previous: null,
    };
    if (state.bytes > this.maxBytes) invalid("capacity exceeded");
    const parsed = parseLines(raw);
    if (parsed.tornTail || !parsed.endsWithNewline) invalid("torn tail");
    for (const line of parsed.lines) {
      if (!line.ok) invalid("corrupt line");
      if (encodeLine(line.kind, line.body).text !== raw.split("\n")[line.line - 1] + "\n")
        invalid("noncanonical or open envelope");
      if (line.kind !== "evaluation-intent" && line.kind !== "evaluation-settlement")
        invalid("record kind");
      closed(line.body, {
        seq: positive,
        previous: nullable(digest),
        value: line.kind === "evaluation-intent" ? validateIntent : validateSettlement,
      });
      const body = line.body as {
        seq: number;
        previous: string | null;
        value: InvocationIntent | InvocationSettlement;
      };
      if (body.seq !== state.sequence + 1 || body.previous !== state.previous)
        invalid("sequence or chain gap");
      if (line.kind === "evaluation-intent") {
        const i = body.value as InvocationIntent,
          k = callerKey(i.namespace, i.key);
        if (
          state.intents.has(i.invocationId) ||
          state.callers.has(k) ||
          state.resultIds.has(i.resultId)
        )
          invalid("duplicate identity");
        state.intents.set(i.invocationId, { intent: i, digest: line.digest });
        state.callers.set(k, i.invocationId);
        state.resultIds.add(i.resultId);
      } else {
        const s = body.value as InvocationSettlement,
          i = state.intents.get(s.invocationId);
        if (
          !i ||
          i.digest !== s.intentDigest ||
          i.intent.resultId !== s.resultId ||
          state.settlements.has(s.invocationId)
        )
          invalid("illegal settlement transition");
        state.settlements.set(s.invocationId, s);
      }
      state.sequence = body.seq;
      state.previous = line.digest;
    }
    if (state.sequence > this.maxRecords) invalid("record capacity");
    return state;
  }
  private capacity(state: LedgerState, intent: InvocationIntent): void {
    validateIntent(intent);
    if (
      state.intents.has(intent.invocationId) ||
      state.callers.has(callerKey(intent.namespace, intent.key)) ||
      state.resultIds.has(intent.resultId)
    )
      throw new InvocationLedgerError("duplicate identity");
    const bytes = Buffer.byteLength(
      encodeLine("evaluation-intent", {
        seq: state.sequence + 1,
        previous: state.previous,
        value: intent,
      }).text,
    );
    if (bytes > INTENT_LIMIT) throw new InvocationLedgerError("intent capacity");
    const open = state.intents.size - state.settlements.size;
    if (
      state.bytes + bytes + (open + 1) * TERMINAL_RESERVE_BYTES > this.maxBytes ||
      state.sequence + open + 2 > this.maxRecords
    )
      throw new InvocationLedgerError("ledger capacity");
  }
  async reserveCapacity(intent: InvocationIntent): Promise<void> {
    this.capacity(await this.load(), intent);
  }
  async appendIntent(
    input: InvocationIntent,
  ): Promise<{ intent: InvocationIntent; digest: string }> {
    const intent = JSON.parse(canonicalJson(input)) as InvocationIntent;
    return mutex.withLock(this.file, async () => {
      await this.options.requireOwnership();
      const state = await this.load();
      this.capacity(state, intent);
      const line = encodeLine("evaluation-intent", {
        seq: state.sequence + 1,
        previous: state.previous,
        value: intent,
      });
      await appendLines(this.file, "", [line.text], this.options.write);
      return { intent, digest: line.digest };
    });
  }
  async appendSettlement(input: InvocationSettlement): Promise<void> {
    const settlement = JSON.parse(canonicalJson(input)) as InvocationSettlement;
    validateSettlement(settlement);
    await mutex.withLock(this.file, async () => {
      await this.options.requireOwnership();
      const state = await this.load(),
        i = state.intents.get(settlement.invocationId),
        existing = state.settlements.get(settlement.invocationId);
      if (existing) {
        if (canonicalJson(existing) === canonicalJson(settlement)) return;
        invalid("conflicting settlement");
      }
      if (!i || i.digest !== settlement.intentDigest || i.intent.resultId !== settlement.resultId)
        invalid("settlement link");
      const line = encodeLine("evaluation-settlement", {
        seq: state.sequence + 1,
        previous: state.previous,
        value: settlement,
      });
      const bytes = Buffer.byteLength(line.text),
        remaining = state.intents.size - state.settlements.size - 1;
      if (
        bytes > TERMINAL_RESERVE_BYTES ||
        state.bytes + bytes + remaining * TERMINAL_RESERVE_BYTES > this.maxBytes ||
        state.sequence + remaining + 1 > this.maxRecords
      )
        invalid("terminal capacity");
      await appendLines(this.file, "", [line.text], this.options.write);
    });
  }
}
