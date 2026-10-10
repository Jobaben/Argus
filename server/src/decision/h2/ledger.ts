import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  DecisionProviderKind,
  DefinitionRef,
  H2AttemptClass,
  ProviderIdentity,
} from "@argus/contracts";
import { KeyedMutex } from "../../mutex.js";
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
import type { ProbeReference, RetainedObservation } from "./sampling.js";

/**
 * The H2 collection ledger (RFC §P.5): the experiment's own append-only
 * record of what it considered, sampled, attempted and got back.
 *
 * It is not the Decision Journal and never passes through its archival, so
 * archiving the journal or restarting the server cannot reopen an item. It
 * uses the journal's line envelope (`encodeLine`: canonical JSON with a
 * sha256 over kind and body), its torn-tail fence, and an `fsync` on every
 * append. Every line carries a `seq`; a gap shows that a line was lost.
 *
 * One writing process is assumed, as for the journal. Nothing here deletes
 * or rewrites a byte: at the size cap, appends are refused.
 */

export const LEDGER_FORMAT = "argus.h2-collection-ledger";
export const CONFIG_FORMAT = "argus.h2-collection-config";
export const MAX_LEDGER_LINE_BYTES = 8 * 1024;
export const DEFAULT_MAX_LEDGER_BYTES = 32 * 1024 * 1024;

export type ResultClass = Exclude<H2AttemptClass, "unresolved">;
export const RESULT_CLASSES: readonly ResultClass[] = [
  "answered",
  "abstained",
  "provider-failed",
  "refused",
  "missing-input",
  "construction-error",
  "unrecorded",
  "unknown-outcome",
];

export interface CollectionConfig {
  reasoningEffort?: string | null;
  format: typeof CONFIG_FORMAT;
  version: 1;
  sampling: {
    method: string;
    seed: string;
    questions: Array<{
      role: "residual" | "probe";
      id: string;
      version: number;
      digest: string;
      rate: number;
    }>;
  };
  window: { minAgeMs: number; maxAgeMs: number };
  eligibility: { residual: string; probe: string };
  exclusions: string[];
  limits: {
    maxCallsPer24h: number;
    minCallIntervalMs: number;
    maxUsdPer24h: number;
    maxTriesPerItem: number;
    retryAfterMs: number;
  };
  provider: RequestedIdentity;
}

/** The identity asked for, before any response. `reportedModel` is unknown until a call returns. */
export interface RequestedIdentity {
  provider: DecisionProviderKind;
  requestedModel: string | null;
  adapterVersion: number;
  elicitation: ProviderIdentity["elicitation"];
}

export interface StartRecord {
  kind: "start";
  seq: number;
  at: string;
  format: typeof LEDGER_FORMAT;
  version: 1;
}
export interface ConfigRecord {
  kind: "config";
  seq: number;
  at: string;
  digest: string;
  config: CollectionConfig;
}
export interface CensusRecord {
  kind: "census";
  seq: number;
  at: string;
  config: string;
  runId: string;
  endedAt: string;
  stratum: string;
  question: DefinitionRef;
  verdict: "selected" | "not-selected" | "excluded";
  reason: string | null;
}
export interface AttemptRecord {
  kind: "attempt";
  seq: number;
  at: string;
  attemptId: string;
  assessmentId: string;
  config: string;
  runId: string;
  runEndedAt: string;
  question: DefinitionRef;
  projection: DefinitionRef;
  provider: RequestedIdentity;
  sample: 0;
  try: number;
  stratum: { class: string; observation: RetainedObservation | null };
  /** Probe only. Residual attempts carry null: that question has no reference stream. */
  reference: ProbeReference | null;
}
export interface ResultRecord {
  kind: "result";
  seq: number;
  at: string;
  attemptId: string;
  class: ResultClass;
  providerCalled: "yes" | "no" | "unknown";
  assessmentId: string | null;
  outcome: { status: "answered" | "abstained" | "failed"; failure: string | null } | null;
  /** A refusal or failure code, when there is one. */
  code: string | null;
  detail: string;
  costUsd: number | null;
  latencyMs: number | null;
  /** Written on a later start, for an attempt an earlier process left open. */
  reconciled: boolean;
}
export interface ExpiredRecord {
  kind: "expired";
  seq: number;
  at: string;
  runId: string;
  question: { id: string; version: number };
  reason: "window-closed";
}

export type LedgerRecord =
  StartRecord | ConfigRecord | CensusRecord | AttemptRecord | ResultRecord | ExpiredRecord;

/** A record as handed to `append`: the ledger assigns the `seq`. */
export type NewRecord = LedgerRecord extends infer R
  ? R extends LedgerRecord
    ? Omit<R, "seq">
    : never
  : never;

export type LedgerNoticeKind =
  | "torn-tail"
  | "recovered-torn-write"
  | "corrupt-line"
  | "malformed-record"
  | "unknown-kind"
  | "seq-gap"
  | "seq-disorder"
  | "missing-start"
  | "duplicate-attempt"
  | "orphan-result"
  | "duplicate-result";

/** Findings that do not lose or contradict a record. */
export const BENIGN_LEDGER_NOTICES: ReadonlySet<LedgerNoticeKind> = new Set([
  "torn-tail",
  "recovered-torn-write",
]);

export interface LedgerNotice {
  kind: LedgerNoticeKind;
  line: number | null;
  detail: string;
}

export interface LedgerView {
  records: Array<{ line: number; record: LedgerRecord }>;
  notices: LedgerNotice[];
  bytes: number;
  lastSeq: number;
}

// ── Validation ──────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNullable = <T>(v: unknown, f: (x: unknown) => x is T): boolean => v === null || f(v);
const isRef = (v: unknown): v is DefinitionRef =>
  isObj(v) && isStr(v.id) && isInt(v.version) && isStr(v.digest);
const isQ = (v: unknown) => isObj(v) && isStr(v.id) && isInt(v.version);
const isProvider = (v: unknown) =>
  isObj(v) &&
  isStr(v.provider) &&
  isNullable(v.requestedModel, isStr) &&
  isInt(v.adapterVersion) &&
  isStr(v.elicitation);
const isObservation = (v: unknown): v is RetainedObservation =>
  isObj(v) &&
  isStr(v.observedAt) &&
  isObj(v.source) &&
  isStr(v.source.store) &&
  isStr(v.source.recordId) &&
  isStr(v.source.recordDigest);

function checkBody(kind: string, b: Obj): string | null {
  if (!isInt(b.seq) || (b.seq as number) < 1) return "seq is not a positive integer";
  if (!isStr(b.at) || !Number.isFinite(Date.parse(b.at))) return "at is not a timestamp";
  switch (kind) {
    case "start":
      return b.format === LEDGER_FORMAT && b.version === 1 ? null : "unknown ledger format";
    case "config":
      return isStr(b.digest) &&
        isObj(b.config) &&
        b.config.format === CONFIG_FORMAT &&
        b.config.version === 1 &&
        isProvider(b.config.provider)
        ? null
        : "malformed config";
    case "census":
      return isStr(b.config) &&
        isStr(b.runId) &&
        isStr(b.endedAt) &&
        isStr(b.stratum) &&
        isRef(b.question) &&
        (b.verdict === "selected" || b.verdict === "not-selected" || b.verdict === "excluded") &&
        isNullable(b.reason, isStr)
        ? null
        : "malformed census";
    case "attempt": {
      const s = b.stratum;
      const r = b.reference;
      const refOk =
        r === null ||
        (isObj(r) &&
          r.stream === "observed-termination" &&
          isStr(r.label) &&
          isRef(r.answerSpace) &&
          isObservation(r.observation) &&
          isStr(r.derivation) &&
          isStr(r.digest));
      return isStr(b.attemptId) &&
        isStr(b.assessmentId) &&
        isStr(b.config) &&
        isStr(b.runId) &&
        isStr(b.runEndedAt) &&
        isRef(b.question) &&
        isRef(b.projection) &&
        isProvider(b.provider) &&
        b.sample === 0 &&
        isInt(b.try) &&
        isObj(s) &&
        isStr(s.class) &&
        isNullable(s.observation, isObservation) &&
        refOk
        ? null
        : "malformed attempt";
    }
    case "result": {
      const o = b.outcome;
      const outcomeOk =
        o === null ||
        (isObj(o) &&
          (o.status === "answered" || o.status === "abstained" || o.status === "failed") &&
          isNullable(o.failure, isStr));
      return isStr(b.attemptId) &&
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
        typeof b.reconciled === "boolean"
        ? null
        : "malformed result";
    }
    case "expired":
      return isStr(b.runId) && isQ(b.question) && b.reason === "window-closed"
        ? null
        : "malformed expiry";
    default:
      return `unknown kind "${kind}"`;
  }
}

/** Parse ledger text into typed records and findings. Pure; writes nothing. */
export function parseLedger(text: string | null): LedgerView {
  const view: LedgerView = { records: [], notices: [], bytes: 0, lastSeq: 0 };
  if (text === null) return view;
  view.bytes = Buffer.byteLength(text, "utf8");
  const parsed = parseLines(text);
  const attempts = new Map<string, string>();
  const results = new Set<string>();
  let expected = 1;
  for (const l of parsed.lines) {
    if (!l.ok) {
      if (parsed.recoveredTorn.has(l.line)) {
        view.notices.push({
          kind: "recovered-torn-write",
          line: l.line,
          detail: "an unacknowledged write, fenced",
        });
      } else {
        view.notices.push({ kind: "corrupt-line", line: l.line, detail: l.problem });
      }
      continue;
    }
    if (l.kind === TORN_MARKER) continue;
    if (!isObj(l.body)) {
      view.notices.push({
        kind: "malformed-record",
        line: l.line,
        detail: "body is not an object",
      });
      continue;
    }
    const problem = checkBody(l.kind, l.body);
    if (problem) {
      view.notices.push({
        kind: problem.startsWith("unknown kind") ? "unknown-kind" : "malformed-record",
        line: l.line,
        detail: problem,
      });
      continue;
    }
    const record = { kind: l.kind, ...l.body } as LedgerRecord;
    if (record.seq !== expected) {
      view.notices.push(
        record.seq > expected
          ? {
              kind: "seq-gap",
              line: l.line,
              detail: `expected seq ${expected}, found ${record.seq}`,
            }
          : {
              kind: "seq-disorder",
              line: l.line,
              detail: `seq ${record.seq} after ${expected - 1}`,
            },
      );
    }
    expected = Math.max(expected, record.seq + 1);
    view.lastSeq = Math.max(view.lastSeq, record.seq);
    if (record.kind === "attempt") {
      const prior = attempts.get(record.attemptId);
      if (prior !== undefined) {
        view.notices.push({
          kind: "duplicate-attempt",
          line: l.line,
          detail: `attempt ${record.attemptId} appears twice`,
        });
        continue;
      }
      attempts.set(record.attemptId, record.assessmentId);
    }
    if (record.kind === "result") {
      if (!attempts.has(record.attemptId)) {
        view.notices.push({
          kind: "orphan-result",
          line: l.line,
          detail: `result for unknown attempt ${record.attemptId}`,
        });
        continue;
      }
      if (results.has(record.attemptId)) {
        view.notices.push({
          kind: "duplicate-result",
          line: l.line,
          detail: `a second result for attempt ${record.attemptId}`,
        });
        continue;
      }
      results.add(record.attemptId);
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
    view.notices.push({
      kind: "missing-start",
      line: view.records[0].line,
      detail: "the first record is not a start",
    });
  }
  return view;
}

export const isDamaged = (view: LedgerView): boolean =>
  view.notices.some((n) => !BENIGN_LEDGER_NOTICES.has(n.kind));

// ── The ledger object ───────────────────────────────────────────────────────

export class LedgerError extends Error {
  constructor(
    readonly code: "ledger-full" | "line-too-large",
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

const locks = new KeyedMutex();

export interface CollectionLedgerOptions {
  root: string;
  maxBytes?: number;
  write?: WriteFn;
}

export class CollectionLedger {
  readonly file: string;
  readonly maxBytes: number;
  private readonly write: WriteFn;
  private view: LedgerView | null = null;
  /** Whether the file is known to end on a newline we wrote. */
  private clean = false;

  constructor(opts: CollectionLedgerOptions) {
    this.file = path.join(path.resolve(opts.root), "collection.jsonl");
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_LEDGER_BYTES;
    this.write = opts.write ?? defaultWrite;
  }

  /** Read the ledger from disk. Never creates or writes anything. */
  async read(): Promise<LedgerView> {
    return locks.withLock(this.file, async () => parseLedger(await readText(this.file)));
  }

  /** The writer's view: loaded once, then kept in step with its own appends. */
  async load(): Promise<LedgerView> {
    if (!this.view) {
      this.view = await this.read();
      this.clean = false;
    }
    return this.view;
  }

  /** Append records with consecutive seqs, in one write and one fsync. */
  async append(records: NewRecord[]): Promise<LedgerRecord[]> {
    if (records.length === 0) return [];
    const view = await this.load();
    return locks.withLock(this.file, async () => {
      let seq = view.lastSeq;
      const out = records.map((r) => ({ ...r, seq: ++seq }) as LedgerRecord);
      const lines = out.map((r) => {
        const { kind, ...body } = r;
        const text = encodeLine(kind, body).text;
        if (Buffer.byteLength(text, "utf8") > MAX_LEDGER_LINE_BYTES) {
          throw new LedgerError(
            "line-too-large",
            `a ${kind} line exceeds ${MAX_LEDGER_LINE_BYTES} bytes`,
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
        throw new LedgerError(
          "ledger-full",
          `the collection ledger would pass ${this.maxBytes} bytes; nothing was written`,
        );
      }
      try {
        await appendLines(this.file, prefix, lines, this.write);
      } catch (e) {
        // Whatever reached the file is fenced by the next append.
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
