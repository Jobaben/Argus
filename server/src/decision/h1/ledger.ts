import { stat } from "node:fs/promises";
import path from "node:path";
import type { DefinitionRef, GateDecisionPrincipal } from "@argus/contracts";
import { KeyedMutex } from "../../mutex.js";
import type { QualificationBasisEntry } from "../../sources/gatePolicy.js";
import type { ResultClass, RequestedIdentity } from "../h2/ledger.js";
import { RESULT_CLASSES } from "../h2/ledger.js";
import {
  appendLines,
  defaultWrite,
  encodeLine,
  parseLines,
  readText,
  tornPrefix,
  TORN_MARKER,
  type WriteFn,
} from "../storage.js";
import type { DeterministicResult, VerdictResult } from "./baselines.js";
import type { OperatorActionReference } from "./gate.js";

/**
 * The H1 collection ledger (RFC §Q.9): the experiment's own append-only record
 * of which gates it saw, what it captured, what it asked, and what the
 * operator did.
 *
 * Its mechanics are the H2 ledger's, on the same primitives: the journal's
 * line envelope (`encodeLine`), the torn-tail fence, `writeAll` and an
 * `fsync` per append, and a `seq` on every line so a lost line is visible. It
 * never passes through journal archival, so neither archival nor a restart
 * reopens an item. Nothing here deletes or rewrites a byte: at the size cap,
 * appends are refused.
 */

export const H1_LEDGER_FORMAT = "argus.h1-collection-ledger";
export const H1_CONFIG_FORMAT = "argus.h1-collection-config";
export const MAX_H1_LINE_BYTES = 16 * 1024;
export const DEFAULT_MAX_H1_LEDGER_BYTES = 32 * 1024 * 1024;

export interface H1Arm {
  requestedModel: string | null;
  identity: RequestedIdentity;
}

export interface H1Config {
  format: typeof H1_CONFIG_FORMAT;
  version: 1;
  question: DefinitionRef;
  projection: DefinitionRef;
  reviewStateRule: string;
  rules: DefinitionRef;
  qualification: DefinitionRef;
  sampling: { method: string; seed: string; rate: number; armMethod: string };
  arms: H1Arm[];
  observation: {
    minIntervalMs: number;
    maxBracketMs: number;
    maxPendingMs: number;
    settleWaitMs: number;
  };
  limits: {
    maxCallsPer24h: number;
    maxOwnCallsPer24h: number;
    minCallIntervalMs: number;
    maxUsdPer24h: number;
    maxTriesPerItem: number;
    retryAfterMs: number;
  };
  storage: { maxSnapshotStoreBytes: number };
}

interface Base {
  seq: number;
  at: string;
}
export interface H1StartRecord extends Base {
  kind: "start";
  format: typeof H1_LEDGER_FORMAT;
  version: 1;
}
export interface H1ConfigRecord extends Base {
  kind: "config";
  digest: string;
  config: H1Config;
}
/** A gate pause seen and not captured, once per item and reason. */
export interface H1GateRecord extends Base {
  kind: "gate";
  itemKey: string;
  instanceId: string;
  phaseId: string;
  attempt: number;
  question: { id: string; version: number };
  reason: string;
}
export interface H1CaptureRecord extends Base {
  kind: "capture";
  captureId: string;
  itemKey: string;
  instanceId: string;
  phaseId: string;
  attempt: number;
  config: string;
  question: DefinitionRef;
  projection: DefinitionRef;
  population: "manual" | "auto-approve-declared";
  relevantRuns: string[];
  snapshot: { sha256: string; bytes: number };
  reviewDigest: string;
  sample: { unit: number; rate: number; selected: boolean; arm: number | null };
  deterministic: DeterministicResult;
  verdict: VerdictResult;
}
/** The first observation whose review state differs from the capture's. */
export interface H1DriftRecord extends Base {
  kind: "drift";
  itemKey: string;
  reviewDigest: string;
}
/** A call slot was available and the pre-call re-check refused it. No call was made. */
export interface H1PrecheckRecord extends Base {
  kind: "precheck";
  itemKey: string;
  reason: string;
}
export interface H1AttemptRecord extends Base {
  kind: "attempt";
  attemptId: string;
  assessmentId: string;
  itemKey: string;
  config: string;
  question: DefinitionRef;
  projection: DefinitionRef;
  provider: RequestedIdentity;
  arm: number;
  sample: 0;
  try: number;
  snapshot: string;
}
export interface H1ResultRecord extends Base {
  kind: "result";
  attemptId: string;
  class: ResultClass;
  providerCalled: "yes" | "no" | "unknown";
  assessmentId: string | null;
  outcome: { status: "answered" | "abstained" | "failed"; failure: string | null } | null;
  code: string | null;
  detail: string;
  costUsd: number | null;
  latencyMs: number | null;
  reconciled: boolean;
}
/** The re-check after a result was durable: did the prediction precede any action? */
export interface H1PostCheckRecord extends Base {
  kind: "post-check";
  attemptId: string;
  eligible: boolean;
  sameState: boolean | null;
  reason: string | null;
}
export interface H1SettleRecord extends Base {
  kind: "settle";
  itemKey: string;
  outcome: "labeled" | "unlabeled" | "window-closed";
  reason: string | null;
  reference: OperatorActionReference | null;
  decisionIds: string[];
  /** The action lies between these two observations. */
  bracket: { lastEligibleAt: string | null; firstIneligibleAt: string };
}

export type H1Record =
  | H1StartRecord
  | H1ConfigRecord
  | H1GateRecord
  | H1CaptureRecord
  | H1DriftRecord
  | H1PrecheckRecord
  | H1AttemptRecord
  | H1ResultRecord
  | H1PostCheckRecord
  | H1SettleRecord;

export type NewH1Record = H1Record extends infer R
  ? R extends H1Record
    ? Omit<R, "seq">
    : never
  : never;

export type H1LedgerNoticeKind =
  | "torn-tail"
  | "recovered-torn-write"
  | "corrupt-line"
  | "malformed-record"
  | "unknown-kind"
  | "seq-gap"
  | "seq-disorder"
  | "missing-start"
  | "duplicate-capture"
  | "duplicate-attempt"
  | "orphan-result"
  | "duplicate-result"
  | "orphan-post-check"
  | "duplicate-post-check"
  | "orphan-item-record"
  | "duplicate-settle";

export const BENIGN_H1_NOTICES: ReadonlySet<H1LedgerNoticeKind> = new Set([
  "torn-tail",
  "recovered-torn-write",
]);

export interface H1LedgerNotice {
  kind: H1LedgerNoticeKind;
  line: number | null;
  detail: string;
}

export interface H1LedgerView {
  records: Array<{ line: number; record: H1Record }>;
  notices: H1LedgerNotice[];
  bytes: number;
  lastSeq: number;
}

// ── Validation ──────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNullable = <T>(v: unknown, f: (x: unknown) => x is T): boolean => v === null || f(v);
const isRef = (v: unknown): v is DefinitionRef =>
  isObj(v) && isStr(v.id) && isInt(v.version) && isStr(v.digest);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isProvider = (v: unknown) =>
  isObj(v) &&
  isStr(v.provider) &&
  isNullable(v.requestedModel, isStr) &&
  isInt(v.adapterVersion) &&
  isStr(v.elicitation);
const isPrincipal = (v: unknown): v is GateDecisionPrincipal =>
  isObj(v) &&
  (v.kind === "unknown" ||
    (v.kind === "session" && isStr(v.username) && isStr(v.role)) ||
    (v.kind === "system" && isStr(v.component)));
const isBasis = (v: unknown): v is QualificationBasisEntry =>
  isObj(v) && isStr(v.runId) && isStr(v.verdictId) && isNum(v.score) && isStr(v.rubricDigest);
const isDeterministic = (v: unknown): v is DeterministicResult =>
  isObj(v) &&
  isRef(v.rules) &&
  (v.classification === "flag" ||
    v.classification === "no-flag" ||
    v.classification === "insufficient-data") &&
  isStrArr(v.fired) &&
  Array.isArray(v.unevaluable) &&
  v.unevaluable.every((u) => isObj(u) && isStr(u.rule) && isStr(u.reason));
const VERDICT_CLASSES = [
  "qualifies",
  "below-threshold",
  "not-configured",
  "ineligible",
  "insufficient-data",
];
const isVerdict = (v: unknown): v is VerdictResult =>
  isObj(v) &&
  isRef(v.definition) &&
  VERDICT_CLASSES.includes(v.classification as string) &&
  isNullable(v.reason, isStr) &&
  isNullable(v.rating, isNum) &&
  isNullable(v.bar, isNum) &&
  isNullable(v.rubricDigest, isStr) &&
  Array.isArray(v.basis) &&
  v.basis.every(isBasis);
const isReference = (v: unknown): v is OperatorActionReference =>
  isObj(v) &&
  v.stream === "operator-action" &&
  isStr(v.derivation) &&
  (v.value === "approve" || v.value === "revise" || v.value === "abort") &&
  (v.label === "sent-back" || v.label === "not-sent-back") &&
  isStr(v.decisionId) &&
  isStr(v.recordDigest) &&
  v.mechanism === "operator" &&
  isStr(v.channel) &&
  isPrincipal(v.principal) &&
  isStr(v.recordedAt) &&
  v.effect === "applied" &&
  Array.isArray(v.others) &&
  isStr(v.digest);

function checkBody(kind: string, b: Obj): string | null {
  if (!isInt(b.seq) || (b.seq as number) < 1) return "seq is not a positive integer";
  if (!isStr(b.at) || !Number.isFinite(Date.parse(b.at))) return "at is not a timestamp";
  const ok = (cond: boolean, what: string) => (cond ? null : `malformed ${what}`);
  switch (kind) {
    case "start":
      return b.format === H1_LEDGER_FORMAT && b.version === 1 ? null : "unknown ledger format";
    case "config":
      return ok(
        isStr(b.digest) &&
          isObj(b.config) &&
          b.config.format === H1_CONFIG_FORMAT &&
          b.config.version === 1,
        "config",
      );
    case "gate":
      return ok(
        isStr(b.itemKey) &&
          isStr(b.instanceId) &&
          isStr(b.phaseId) &&
          isInt(b.attempt) &&
          isObj(b.question) &&
          isStr(b.question.id) &&
          isInt(b.question.version) &&
          isStr(b.reason),
        "gate",
      );
    case "capture": {
      const s = b.sample;
      return ok(
        isStr(b.captureId) &&
          isStr(b.itemKey) &&
          isStr(b.instanceId) &&
          isStr(b.phaseId) &&
          isInt(b.attempt) &&
          isStr(b.config) &&
          isRef(b.question) &&
          isRef(b.projection) &&
          (b.population === "manual" || b.population === "auto-approve-declared") &&
          isStrArr(b.relevantRuns) &&
          isObj(b.snapshot) &&
          isStr(b.snapshot.sha256) &&
          isInt(b.snapshot.bytes) &&
          isStr(b.reviewDigest) &&
          isObj(s) &&
          isNum(s.unit) &&
          isNum(s.rate) &&
          isBool(s.selected) &&
          isNullable(s.arm, isInt) &&
          isDeterministic(b.deterministic) &&
          isVerdict(b.verdict),
        "capture",
      );
    }
    case "drift":
      return ok(isStr(b.itemKey) && isStr(b.reviewDigest), "drift");
    case "precheck":
      return ok(isStr(b.itemKey) && isStr(b.reason), "precheck");
    case "attempt":
      return ok(
        isStr(b.attemptId) &&
          isStr(b.assessmentId) &&
          isStr(b.itemKey) &&
          isStr(b.config) &&
          isRef(b.question) &&
          isRef(b.projection) &&
          isProvider(b.provider) &&
          isInt(b.arm) &&
          b.sample === 0 &&
          isInt(b.try) &&
          isStr(b.snapshot),
        "attempt",
      );
    case "result": {
      const o = b.outcome;
      const outcomeOk =
        o === null ||
        (isObj(o) &&
          (o.status === "answered" || o.status === "abstained" || o.status === "failed") &&
          isNullable(o.failure, isStr));
      return ok(
        isStr(b.attemptId) &&
          RESULT_CLASSES.includes(b.class as ResultClass) &&
          (b.providerCalled === "yes" ||
            b.providerCalled === "no" ||
            b.providerCalled === "unknown") &&
          isNullable(b.assessmentId, isStr) &&
          outcomeOk &&
          isNullable(b.code, isStr) &&
          isStr(b.detail) &&
          isNullable(b.costUsd, isNum) &&
          isNullable(b.latencyMs, isNum) &&
          isBool(b.reconciled),
        "result",
      );
    }
    case "post-check":
      return ok(
        isStr(b.attemptId) &&
          isBool(b.eligible) &&
          isNullable(b.sameState, isBool) &&
          isNullable(b.reason, isStr),
        "post-check",
      );
    case "settle": {
      const br = b.bracket;
      return ok(
        isStr(b.itemKey) &&
          (b.outcome === "labeled" || b.outcome === "unlabeled" || b.outcome === "window-closed") &&
          isNullable(b.reason, isStr) &&
          isNullable(b.reference, isReference) &&
          (b.outcome === "labeled") === (b.reference !== null) &&
          isStrArr(b.decisionIds) &&
          isObj(br) &&
          isNullable(br.lastEligibleAt, isStr) &&
          isStr(br.firstIneligibleAt),
        "settle",
      );
    }
    default:
      return `unknown kind "${kind}"`;
  }
}

/** Parse ledger text into typed records and findings. Pure; writes nothing. */
export function parseH1Ledger(text: string | null): H1LedgerView {
  const view: H1LedgerView = { records: [], notices: [], bytes: 0, lastSeq: 0 };
  if (text === null) return view;
  view.bytes = Buffer.byteLength(text, "utf8");
  const parsed = parseLines(text);
  const captures = new Set<string>();
  const attempts = new Set<string>();
  const results = new Set<string>();
  const postChecks = new Set<string>();
  const settles = new Set<string>();
  let expected = 1;
  const notice = (kind: H1LedgerNoticeKind, line: number, detail: string) =>
    view.notices.push({ kind, line, detail });
  for (const l of parsed.lines) {
    if (!l.ok) {
      if (parsed.recoveredTorn.has(l.line))
        notice("recovered-torn-write", l.line, "an unacknowledged write, fenced");
      else notice("corrupt-line", l.line, l.problem);
      continue;
    }
    if (l.kind === TORN_MARKER) continue;
    if (!isObj(l.body)) {
      notice("malformed-record", l.line, "body is not an object");
      continue;
    }
    const problem = checkBody(l.kind, l.body);
    if (problem) {
      notice(
        problem.startsWith("unknown kind") ? "unknown-kind" : "malformed-record",
        l.line,
        problem,
      );
      continue;
    }
    const record = { kind: l.kind, ...l.body } as H1Record;
    if (record.seq !== expected) {
      if (record.seq > expected)
        notice("seq-gap", l.line, `expected seq ${expected}, found ${record.seq}`);
      else notice("seq-disorder", l.line, `seq ${record.seq} after ${expected - 1}`);
    }
    expected = Math.max(expected, record.seq + 1);
    view.lastSeq = Math.max(view.lastSeq, record.seq);
    switch (record.kind) {
      case "capture":
        if (captures.has(record.itemKey)) {
          notice("duplicate-capture", l.line, `item ${record.itemKey} is captured twice`);
          continue;
        }
        captures.add(record.itemKey);
        break;
      case "drift":
      case "precheck":
        if (!captures.has(record.itemKey)) {
          notice(
            "orphan-item-record",
            l.line,
            `${record.kind} for uncaptured item ${record.itemKey}`,
          );
          continue;
        }
        break;
      case "settle":
        if (!captures.has(record.itemKey)) {
          notice("orphan-item-record", l.line, `settle for uncaptured item ${record.itemKey}`);
          continue;
        }
        if (settles.has(record.itemKey)) {
          notice("duplicate-settle", l.line, `item ${record.itemKey} is settled twice`);
          continue;
        }
        settles.add(record.itemKey);
        break;
      case "attempt":
        if (!captures.has(record.itemKey)) {
          notice("orphan-item-record", l.line, `attempt for uncaptured item ${record.itemKey}`);
          continue;
        }
        if (attempts.has(record.attemptId)) {
          notice("duplicate-attempt", l.line, `attempt ${record.attemptId} appears twice`);
          continue;
        }
        attempts.add(record.attemptId);
        break;
      case "result":
        if (!attempts.has(record.attemptId)) {
          notice("orphan-result", l.line, `result for unknown attempt ${record.attemptId}`);
          continue;
        }
        if (results.has(record.attemptId)) {
          notice("duplicate-result", l.line, `a second result for attempt ${record.attemptId}`);
          continue;
        }
        results.add(record.attemptId);
        break;
      case "post-check":
        if (!results.has(record.attemptId)) {
          notice(
            "orphan-post-check",
            l.line,
            `post-check for attempt ${record.attemptId} with no result`,
          );
          continue;
        }
        if (postChecks.has(record.attemptId)) {
          notice(
            "duplicate-post-check",
            l.line,
            `a second post-check for attempt ${record.attemptId}`,
          );
          continue;
        }
        postChecks.add(record.attemptId);
        break;
    }
    view.records.push({ line: l.line, record });
  }
  if (parsed.tornTail > 0) {
    view.notices.push({
      kind: "torn-tail",
      line: parsed.lines.length + 1,
      detail: `${parsed.tornTail} bytes of an unacknowledged write`,
    });
  }
  if (view.records.length > 0 && view.records[0].record.kind !== "start") {
    notice("missing-start", view.records[0].line, "the first record is not a start");
  }
  return view;
}

export const isH1Damaged = (view: H1LedgerView): boolean =>
  view.notices.some((n) => !BENIGN_H1_NOTICES.has(n.kind));

// ── The ledger object ───────────────────────────────────────────────────────

export class H1LedgerError extends Error {
  constructor(
    readonly code: "ledger-full" | "line-too-large",
    message: string,
  ) {
    super(message);
    this.name = "H1LedgerError";
  }
}

const locks = new KeyedMutex();

export interface H1LedgerOptions {
  root: string;
  maxBytes?: number;
  write?: WriteFn;
}

export class H1Ledger {
  readonly file: string;
  readonly maxBytes: number;
  private readonly write: WriteFn;
  private view: H1LedgerView | null = null;
  private clean = false;

  constructor(opts: H1LedgerOptions) {
    this.file = path.join(path.resolve(opts.root), "collection.jsonl");
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_H1_LEDGER_BYTES;
    this.write = opts.write ?? defaultWrite;
  }

  /** Read the ledger from disk. Never creates or writes anything. */
  async read(): Promise<H1LedgerView> {
    return locks.withLock(this.file, async () => parseH1Ledger(await readText(this.file)));
  }

  /** The writer's view: loaded once, then kept in step with its own appends. */
  async load(): Promise<H1LedgerView> {
    if (!this.view) {
      this.view = await this.read();
      this.clean = false;
    }
    return this.view;
  }

  /** Append records with consecutive seqs, in one write and one fsync. */
  async append(records: NewH1Record[]): Promise<H1Record[]> {
    if (records.length === 0) return [];
    const view = await this.load();
    return locks.withLock(this.file, async () => {
      let seq = view.lastSeq;
      const out = records.map((r) => ({ ...r, seq: ++seq }) as H1Record);
      const lines = out.map((r) => {
        const { kind, ...body } = r;
        const text = encodeLine(kind, body).text;
        if (Buffer.byteLength(text, "utf8") > MAX_H1_LINE_BYTES) {
          throw new H1LedgerError(
            "line-too-large",
            `a ${kind} line exceeds ${MAX_H1_LINE_BYTES} bytes`,
          );
        }
        return text;
      });
      const prefix = this.clean ? "" : await tornPrefix(this.file, out[0].at);
      const size = await stat(this.file).then(
        (s) => s.size,
        () => 0,
      );
      const adding = Buffer.byteLength(prefix + lines.join(""), "utf8");
      if (size + adding > this.maxBytes) {
        throw new H1LedgerError(
          "ledger-full",
          `the H1 collection ledger would pass ${this.maxBytes} bytes; nothing was written`,
        );
      }
      try {
        await appendLines(this.file, prefix, lines, this.write);
      } catch (e) {
        this.view = null;
        throw e;
      }
      this.clean = true;
      const firstLine =
        view.records.length === 0 ? 1 : view.records[view.records.length - 1].line + 1;
      out.forEach((record, i) => view.records.push({ line: firstLine + i, record }));
      view.lastSeq = seq;
      view.bytes = size + adding;
      return out;
    });
  }
}
