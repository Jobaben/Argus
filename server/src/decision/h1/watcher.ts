import { randomBytes } from "node:crypto";
import type {
  DecisionProjection,
  DefinitionRef,
  GateDecision,
  H1CollectionStatus,
  PipelineDefinition,
  PipelineInstance,
  ProviderIdentity,
  StoredSnapshot,
  Verdict,
} from "@argus/contracts";
import { log } from "../../log.js";
import { canonicalDigest, sha256Hex } from "../canonical.js";
import { SPENT, TERMINAL } from "../h2/items.js";
import type { RequestedIdentity } from "../h2/ledger.js";
import { classifyServiceResult, fromAssessment, requestedIdentity } from "../h2/watcher.js";
import type { DecisionJournal } from "../journal.js";
import type { DecisionRegistry } from "../registry.js";
import type { DecisionService } from "../service.js";
import {
  applyGateRules,
  GATE_RULES_V1_REF,
  QUALIFICATION_V1_REF,
  verdictBaseline,
} from "./baselines.js";
import { gatherGateReview, type GatherCache, type H1Sources } from "./collect.js";
import type { H1Enablement, H1Settings } from "./config.js";
import { H1_QUESTION } from "./definitions.js";
import { gateEligibility, gateItemKey, recordsFor, settle, type GateItem } from "./gate.js";
import {
  H1_CONFIG_FORMAT,
  H1_LEDGER_FORMAT,
  H1LedgerError,
  isH1Damaged,
  type H1AttemptRecord,
  type H1CaptureRecord,
  type H1Config,
  type H1Ledger,
  type H1LedgerView,
  type H1ResultRecord,
  type NewH1Record,
} from "./ledger.js";
import {
  projectGateReview,
  REVIEW_STATE_RULE,
  reviewStateDigest,
  type GateReviewBody,
} from "./projection.js";
import type { H1SnapshotStore } from "./snapshots.js";

/**
 * The H1 shadow-collection watcher (RFC §Q).
 *
 * On every enabled check, in this order, and without taking any instance
 * lock:
 *
 * 1. close attempts an earlier process left open, and post-check any result
 *    that has none;
 * 2. **capture** each newly eligible gate: snapshot, both baselines, then a
 *    re-read proving the attempt is still eligible — no model call, no budget;
 * 3. **observe** captured items: review-state drift while the gate is open,
 *    **settlement** once it has closed;
 * 4. at most one provider call, on the captured snapshot, after a pre-call
 *    re-check, followed by a post-check.
 *
 * Nothing it writes is outside its ledger, its snapshot store and (through
 * the service) the Decision Journal. It never blocks the operator: if the
 * operator acts first, the item is simply not called, or not scored.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const H1_PAUSE = {
  budget: 15 * MINUTE,
  storage: 60 * MINUTE,
  error: 60 * MINUTE,
  other: 5 * MINUTE,
} as const;
export const SAMPLING_METHOD = "sha256-prefix-52@1";
export const ARM_METHOD = "sha256-prefix-52-arm@1";

export interface ShadowSpend {
  atMs: number;
  costUsd: number | null;
}

export type H1CheckOutcome =
  | { action: "inactive" }
  | { action: "overlap" }
  | { action: "halted"; detail: string }
  | { action: "done"; captured: number; settled: number; call: H1CallOutcome }
  | { action: "error"; detail: string };

export type H1CallOutcome =
  | { kind: "paused"; until: string }
  | { kind: "deferred"; detail: string }
  | { kind: "limited"; detail: string }
  | { kind: "idle" }
  | { kind: "prechecked"; reason: string }
  | { kind: "attempted"; attemptId: string };

export interface H1Arm {
  /** The service's provider key for this arm. */
  providerKey: string;
  identity: () => ProviderIdentity;
}

export interface H1WatcherDeps {
  enablement: () => H1Enablement;
  ledger: H1Ledger;
  snapshots: H1SnapshotStore;
  journal: Pick<DecisionJournal, "read">;
  service: Pick<DecisionService, "assessSnapshot">;
  registry: DecisionRegistry;
  arms: H1Arm[];
  sources: H1Sources;
  runner: { inFlight(): number; passesStarted(): number };
  spendBlocked: (now: Date) => Promise<boolean>;
  /** The other experiment's spent invocations, for the combined limits (§Q.8). */
  otherSpend?: () => Promise<ShadowSpend[]>;
  now: () => Date;
  newId?: (prefix: "H1C" | "H1A" | "DA") => string;
  /** Test seam: throwing here simulates the process stopping at that point. */
  fault?: (
    point: "captured" | "attempt-written" | "assessed" | "result-written",
  ) => void | Promise<void>;
  maxCapturesPerCheck?: number;
  maxObservationsPerCheck?: number;
}

export interface H1Watcher {
  check(): Promise<H1CheckOutcome>;
  status(): H1CollectionStatus["watcher"];
  /** Whether the last check wrote an attempt: a provider call happened or may have. */
  invokedLastCheck(): boolean;
  /** Spent invocations in the ledger, for the other experiment's combined limits. */
  spent(): Promise<ShadowSpend[]>;
}

// ── Ledger index ────────────────────────────────────────────────────────────

interface ItemState {
  capture: H1CaptureRecord;
  drift: boolean;
  attempts: Array<{
    attempt: H1AttemptRecord;
    result: H1ResultRecord | null;
    postChecked: boolean;
  }>;
  settled: boolean;
}

interface H1Index {
  started: boolean;
  configDigests: string[];
  gates: Set<string>;
  items: Map<string, ItemState>;
  attempts: Array<{
    attempt: H1AttemptRecord;
    result: H1ResultRecord | null;
    postChecked: boolean;
  }>;
}

export function indexH1(view: H1LedgerView): H1Index {
  const idx: H1Index = {
    started: false,
    configDigests: [],
    gates: new Set(),
    items: new Map(),
    attempts: [],
  };
  const byAttempt = new Map<string, H1Index["attempts"][number]>();
  for (const { record: r } of view.records) {
    switch (r.kind) {
      case "start":
        idx.started = true;
        break;
      case "config":
        idx.configDigests.push(r.digest);
        break;
      case "gate":
        idx.gates.add(`${r.itemKey}|${r.reason}`);
        break;
      case "capture":
        if (!idx.items.has(r.itemKey)) {
          idx.items.set(r.itemKey, { capture: r, drift: false, attempts: [], settled: false });
        }
        break;
      case "drift": {
        const it = idx.items.get(r.itemKey);
        if (it) it.drift = true;
        break;
      }
      case "attempt": {
        const e = { attempt: r, result: null, postChecked: false };
        idx.attempts.push(e);
        byAttempt.set(r.attemptId, e);
        idx.items.get(r.itemKey)?.attempts.push(e);
        break;
      }
      case "result": {
        const e = byAttempt.get(r.attemptId);
        if (e && !e.result) e.result = r;
        break;
      }
      case "post-check": {
        const e = byAttempt.get(r.attemptId);
        if (e) e.postChecked = true;
        break;
      }
      case "settle": {
        const it = idx.items.get(r.itemKey);
        if (it) it.settled = true;
        break;
      }
      default:
        break;
    }
  }
  return idx;
}

const isSpentEntry = (e: { result: H1ResultRecord | null }) =>
  e.result === null || SPENT.has(e.result.class);

export function spentFrom(view: H1LedgerView): ShadowSpend[] {
  return indexH1(view)
    .attempts.filter(isSpentEntry)
    .map((e) => ({ atMs: Date.parse(e.attempt.at), costUsd: e.result?.costUsd ?? null }));
}

/** Label-blind draw in [0, 1): the first 52 bits of a hash of the seed, question and exact item. */
export function h1Unit(
  seed: string,
  q: { id: string; version: number },
  item: GateItem,
  salt = "",
): number {
  const hex = sha256Hex(
    `${seed}${salt}|${q.id}@${q.version}|${item.instanceId}|${item.phaseId}#${item.attempt}`,
  ).slice(0, 13);
  return parseInt(hex, 16) / 2 ** 52;
}

export function buildH1Config(
  settings: H1Settings,
  question: DefinitionRef,
  projection: DefinitionRef,
  arms: RequestedIdentity[],
  maxSnapshotStoreBytes: number,
): { config: H1Config; digest: string } {
  const config: H1Config = {
    format: H1_CONFIG_FORMAT,
    version: 1,
    question,
    projection,
    reviewStateRule: REVIEW_STATE_RULE,
    rules: { ...GATE_RULES_V1_REF },
    qualification: { ...QUALIFICATION_V1_REF },
    sampling: {
      method: SAMPLING_METHOD,
      seed: settings.seed,
      rate: settings.rate,
      armMethod: ARM_METHOD,
    },
    arms: arms.map((identity) => ({ requestedModel: identity.requestedModel, identity })),
    observation: { ...settings.observation },
    limits: { ...settings.limits },
    storage: { maxSnapshotStoreBytes },
  };
  return { config, digest: canonicalDigest(config).sha256 };
}

const bounded = (s: string, max = 300) => {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join("") : s;
};

type Classified = Omit<H1ResultRecord, "kind" | "seq" | "at" | "attemptId" | "reconciled">;

function pauseFor(c: Classified): number {
  if (c.class === "refused") {
    if (c.code === "budget-blocked" || c.code === "disabled") return H1_PAUSE.budget;
    if (c.code === "storage-refused") return H1_PAUSE.storage;
    if (c.code === "busy") return 0;
    return H1_PAUSE.other;
  }
  if (c.class === "missing-input" || c.class === "construction-error") return H1_PAUSE.other;
  if (c.class === "unknown-outcome") return H1_PAUSE.error;
  return 0;
}

// ── The watcher ─────────────────────────────────────────────────────────────

interface Resolved {
  ref: DefinitionRef;
  projection: DefinitionRef;
  def: DecisionProjection;
}

export function createH1Watcher(deps: H1WatcherDeps): H1Watcher {
  const newId =
    deps.newId ?? ((prefix: string) => `${prefix}-${randomBytes(12).toString("base64url")}`);
  const maxCaptures = deps.maxCapturesPerCheck ?? 8;
  const maxObservations = deps.maxObservationsPerCheck ?? 16;

  let running = false;
  let invoked = false;
  let pausedUntil = 0;
  let lastPasses: number | null = null;
  let state: H1CollectionStatus["watcher"] = { state: "inactive", detail: null, until: null };
  /** In-memory observation times; lost on restart, which only widens a bracket. */
  const lastOpenAt = new Map<string, number>();
  const lastObservedAt = new Map<string, number>();
  const closedSince = new Map<string, number>();

  const set = (
    s: H1CollectionStatus["watcher"]["state"],
    detail: string | null,
    until: string | null = null,
  ) => {
    state = { state: s, detail, until };
  };

  function resolve(): Resolved | string {
    const q = deps.registry.question(H1_QUESTION.id, H1_QUESTION.version);
    if (!q) return `${H1_QUESTION.id}@${H1_QUESTION.version} is not registered`;
    if (q.def.answers.shape !== "binary")
      return `${H1_QUESTION.id}@${H1_QUESTION.version} is not binary`;
    const p = deps.registry.projection(q.def.projection.id, q.def.projection.version);
    if (!p)
      return `projection ${q.def.projection.id}@${q.def.projection.version} is not registered`;
    return { ref: q.ref, projection: p.ref, def: p.def };
  }

  /** One fresh reading of an item: the instance, then the gate log, then its definition. */
  async function read(item: GateItem): Promise<{
    inst: PipelineInstance | null;
    decisions: GateDecision[];
    def: PipelineDefinition | undefined;
  }> {
    const inst = await deps.sources.readInstance(item.instanceId);
    const decisions = await deps.sources.readGateDecisions(item.instanceId);
    const def = inst ? await deps.sources.definitionFor(inst) : undefined;
    return { inst, decisions, def };
  }

  async function project(
    q: Resolved,
    inst: PipelineInstance,
    item: GateItem,
    def: PipelineDefinition | undefined,
    cache: GatherCache,
  ) {
    const phase = inst.phases.find((p) => p.id === item.phaseId)!;
    const input = await gatherGateReview(deps.sources, inst, phase, def, deps.now(), cache);
    return { input, built: projectGateReview(q.projection, q.def, input) };
  }

  /** Re-check an item now: still eligible, with the same runs and the same review state? */
  async function recheck(
    q: Resolved,
    capture: H1CaptureRecord,
    cache: GatherCache,
  ): Promise<{
    eligible: boolean;
    sameState: boolean | null;
    reason: string | null;
    digest: string | null;
  }> {
    const item = {
      instanceId: capture.instanceId,
      phaseId: capture.phaseId,
      attempt: capture.attempt,
    };
    const { inst, decisions, def } = await read(item);
    const e = gateEligibility(inst, item, def, decisions);
    if (!e.ok) return { eligible: false, sameState: null, reason: e.reason, digest: null };
    if (e.relevantRuns.join("\u0000") !== capture.relevantRuns.join("\u0000")) {
      return { eligible: false, sameState: null, reason: "relevant-runs-changed", digest: null };
    }
    const { built } = await project(q, inst!, item, def, cache);
    if (!built.ok)
      return {
        eligible: true,
        sameState: false,
        reason: `unprojectable:${built.reason}`,
        digest: `unprojectable:${built.reason}`,
      };
    const digest = reviewStateDigest(built.snapshot);
    // The gate log again, after the projection's reads: a decision recorded
    // meanwhile makes the attempt ineligible.
    const after = await deps.sources.readGateDecisions(item.instanceId);
    if (recordsFor(item, after).length > 0) {
      return { eligible: false, sameState: null, reason: "prior-decision-record", digest };
    }
    return { eligible: true, sameState: digest === capture.reviewDigest, reason: null, digest };
  }

  // ── 1. Reconcile ──────────────────────────────────────────────────────────

  async function reconcile(
    q: Resolved,
    idx: H1Index,
    at: string,
    cache: GatherCache,
  ): Promise<void> {
    const open = idx.attempts.filter((e) => e.result === null);
    if (open.length > 0) {
      const view = await deps.journal.read();
      const byId = new Map(view.entries.map((e) => [e.assessment.id, e.assessment]));
      const out: NewH1Record[] = open.map((e) => {
        const found = byId.get(e.attempt.assessmentId);
        const c: Classified = found
          ? { ...fromAssessment(found), detail: "reconciled from the journal after a restart" }
          : {
              class: "unknown-outcome",
              providerCalled: "unknown",
              assessmentId: null,
              outcome: null,
              code: "interrupted",
              detail:
                "the process stopped during this attempt; the provider call may or may not have happened, and it is not retried",
              costUsd: null,
              latencyMs: null,
            };
        return { kind: "result", at, attemptId: e.attempt.attemptId, reconciled: true, ...c };
      });
      await deps.ledger.append(out);
    }
    // Every assessed result gets a post-check; a late one is still a proof if
    // the gate is still eligible and unchanged now.
    const fresh = indexH1(await deps.ledger.load());
    for (const e of fresh.attempts) {
      if (!e.result || e.postChecked) continue;
      if (e.result.assessmentId === null) continue;
      const it = fresh.items.get(e.attempt.itemKey);
      if (!it) continue;
      const r = await recheck(q, it.capture, cache);
      await deps.ledger.append([
        {
          kind: "post-check",
          at: deps.now().toISOString(),
          attemptId: e.attempt.attemptId,
          eligible: r.eligible,
          sameState: r.sameState,
          reason: r.reason,
        },
      ]);
    }
  }

  // ── 2. Capture ────────────────────────────────────────────────────────────

  async function capture(
    q: Resolved,
    settings: H1Settings,
    digest: string,
    idx: H1Index,
    cache: GatherCache,
    verdicts: () => Promise<Map<string, Verdict>>,
  ): Promise<number> {
    const instances = await deps.sources.listInstances();
    const gateLines: NewH1Record[] = [];
    const noteGate = (item: GateItem, key: string, reason: string) => {
      if (idx.gates.has(`${key}|${reason}`) || gateLines.length >= 200) return;
      idx.gates.add(`${key}|${reason}`);
      gateLines.push({
        kind: "gate",
        at: deps.now().toISOString(),
        itemKey: key,
        ...item,
        question: { id: q.ref.id, version: q.ref.version },
        reason,
      });
    };
    let captured = 0;
    try {
      for (const listed of instances) {
        if (
          listed.status === "succeeded" ||
          listed.status === "failed" ||
          listed.status === "aborted"
        )
          continue;
        for (const lp of listed.phases) {
          if (lp.status !== "awaiting-approval") continue;
          const item: GateItem = { instanceId: listed.id, phaseId: lp.id, attempt: lp.attempt };
          const key = gateItemKey(item, q.ref);
          if (idx.items.has(key)) continue;
          if (captured >= maxCaptures) return captured;
          const { inst, decisions, def } = await read(item);
          const e = gateEligibility(inst, item, def, decisions);
          if (!e.ok) {
            noteGate(item, key, e.reason);
            continue;
          }
          const { built } = await project(q, inst!, item, def, cache);
          if (!built.ok) {
            noteGate(item, key, `snapshot-${built.reason}`);
            continue;
          }
          const snapshot = built.snapshot;
          const phase = inst!.phases.find((p) => p.id === item.phaseId)!;
          const phaseDef = def?.phases.find((p) => p.id === item.phaseId);
          const deterministic = applyGateRules(snapshot.content.body as GateReviewBody);
          const verdict = verdictBaseline(phase, phaseDef, await verdicts());
          try {
            await deps.snapshots.publish(snapshot);
          } catch (err) {
            noteGate(item, key, "store-full");
            log.warn("h1 snapshot not stored", { err });
            return captured;
          }
          // The proof the capture precedes any decision: re-read after the
          // snapshot and baselines, and find the attempt still eligible.
          const again = await read(item);
          const e2 = gateEligibility(again.inst, item, again.def, again.decisions);
          if (!e2.ok || e2.relevantRuns.join("\u0000") !== e.relevantRuns.join("\u0000")) {
            noteGate(item, key, "capture-raced");
            continue;
          }
          const unit = h1Unit(settings.seed, q.ref, item);
          const selected = unit < settings.rate;
          const arm = selected
            ? Math.min(
                deps.arms.length - 1,
                Math.floor(h1Unit(settings.seed, q.ref, item, "|arm") * deps.arms.length),
              )
            : null;
          const record: NewH1Record = {
            kind: "capture",
            at: deps.now().toISOString(),
            captureId: newId("H1C"),
            itemKey: key,
            ...item,
            config: digest,
            question: q.ref,
            projection: q.projection,
            population: e.population,
            relevantRuns: e.relevantRuns,
            snapshot: { sha256: snapshot.sha256, bytes: snapshot.bytes },
            reviewDigest: reviewStateDigest(snapshot),
            sample: { unit, rate: settings.rate, selected, arm },
            deterministic,
            verdict,
          };
          const [written] = await deps.ledger.append([record]);
          idx.items.set(key, {
            capture: written as H1CaptureRecord,
            drift: false,
            attempts: [],
            settled: false,
          });
          lastOpenAt.set(key, deps.now().getTime());
          lastObservedAt.set(key, deps.now().getTime());
          captured++;
          await deps.fault?.("captured");
        }
      }
      return captured;
    } finally {
      await deps.ledger.append(gateLines);
    }
  }

  // ── 3. Observe and settle ─────────────────────────────────────────────────

  async function observe(
    q: Resolved,
    settings: H1Settings,
    idx: H1Index,
    cache: GatherCache,
  ): Promise<number> {
    const nowMs = deps.now().getTime();
    const open = [...idx.items.entries()]
      .filter(([, it]) => !it.settled)
      .filter(
        ([key]) => nowMs - (lastObservedAt.get(key) ?? 0) >= settings.observation.minIntervalMs,
      )
      .sort(
        ([a], [b]) =>
          (lastObservedAt.get(a) ?? 0) - (lastObservedAt.get(b) ?? 0) || (a < b ? -1 : 1),
      )
      .slice(0, maxObservations);
    let settled = 0;
    for (const [key, it] of open) {
      const c = it.capture;
      const item = { instanceId: c.instanceId, phaseId: c.phaseId, attempt: c.attempt };
      const at = deps.now().toISOString();
      const t = deps.now().getTime();
      lastObservedAt.set(key, t);
      const { inst, decisions, def } = await read(item);
      const phase = inst?.phases.find((p) => p.id === item.phaseId);
      const gateOpen =
        !!phase &&
        phase.attempt === item.attempt &&
        phase.status === "awaiting-approval" &&
        phase.pause === "gate";
      const lastOpen = lastOpenAt.get(key) ?? null;
      const settleLine = (
        outcome: "labeled" | "unlabeled" | "window-closed",
        reason: string | null,
        reference: import("./gate.js").OperatorActionReference | null,
        decisionIds: string[],
      ): NewH1Record => ({
        kind: "settle",
        at,
        itemKey: key,
        outcome,
        reason,
        reference,
        decisionIds,
        bracket: {
          lastEligibleAt: lastOpen === null ? null : new Date(lastOpen).toISOString(),
          firstIneligibleAt: new Date(closedSince.get(key) ?? t).toISOString(),
        },
      });
      if (gateOpen) {
        closedSince.delete(key);
        if (t - Date.parse(c.at) > settings.observation.maxPendingMs) {
          await deps.ledger.append([
            settleLine("window-closed", "observation-window-closed", null, []),
          ]);
          it.settled = true;
          settled++;
          continue;
        }
        lastOpenAt.set(key, t);
        if (!it.drift) {
          const { built } = await project(q, inst!, item, def, cache);
          const digest = built.ok
            ? reviewStateDigest(built.snapshot)
            : `unprojectable:${built.reason}`;
          if (digest !== c.reviewDigest) {
            await deps.ledger.append([{ kind: "drift", at, itemKey: key, reviewDigest: digest }]);
            it.drift = true;
          }
        }
        continue;
      }
      if (!closedSince.has(key)) closedSince.set(key, t);
      const s = settle(item, inst, decisions);
      if (s.kind === "wait") {
        if (t - closedSince.get(key)! < settings.observation.settleWaitMs) continue;
        await deps.ledger.append([
          settleLine(
            "unlabeled",
            "effect-incomplete",
            null,
            recordsFor(item, decisions).map((d) => d.id),
          ),
        ]);
      } else if (s.kind === "labeled") {
        await deps.ledger.append([
          settleLine("labeled", null, s.reference, [s.reference.decisionId]),
        ]);
      } else {
        await deps.ledger.append([settleLine("unlabeled", s.reason, null, s.decisionIds)]);
      }
      it.settled = true;
      closedSince.delete(key);
      lastOpenAt.delete(key);
      settled++;
    }
    return settled;
  }

  // ── 4. The call ───────────────────────────────────────────────────────────

  async function call(
    q: Resolved,
    settings: H1Settings,
    digest: string,
    idx: H1Index,
    cache: GatherCache,
  ): Promise<H1CallOutcome> {
    const now = deps.now();
    const nowMs = now.getTime();
    const at = now.toISOString();
    if (nowMs < pausedUntil) return { kind: "paused", until: new Date(pausedUntil).toISOString() };
    const passes = deps.runner.passesStarted();
    if (lastPasses === null || passes !== lastPasses) {
      const detail =
        lastPasses === null
          ? "first check since start"
          : "another analysis pass ran since the last check";
      lastPasses = passes;
      return { kind: "deferred", detail };
    }
    if (deps.runner.inFlight() > 0)
      return { kind: "deferred", detail: "an analysis pass is in flight" };
    const since = nowMs - DAY;
    const mine = idx.attempts.filter(isSpentEntry).filter((e) => Date.parse(e.attempt.at) > since);
    const other = (deps.otherSpend ? await deps.otherSpend() : []).filter((s) => s.atMs > since);
    const all = [
      ...mine.map((e) => ({ atMs: Date.parse(e.attempt.at), costUsd: e.result?.costUsd ?? null })),
      ...other,
    ];
    const L = settings.limits;
    if (all.length >= L.maxCallsPer24h) {
      return {
        kind: "limited",
        detail: `${all.length} shadow invocations in the last 24 hours (limit ${L.maxCallsPer24h})`,
      };
    }
    if (mine.length >= L.maxOwnCallsPer24h) {
      return {
        kind: "limited",
        detail: `${mine.length} H1 invocations in the last 24 hours (share ${L.maxOwnCallsPer24h})`,
      };
    }
    const last = all.reduce((m, s) => Math.max(m, s.atMs), -Infinity);
    if (nowMs - last < L.minCallIntervalMs) {
      return {
        kind: "limited",
        detail: "the minimum interval since the last shadow invocation has not passed",
      };
    }
    if (all.some((e) => e.costUsd === null || !Number.isFinite(e.costUsd) || e.costUsd < 0)) {
      return {
        kind: "limited",
        detail: "a potentially spent invocation has unknown cost in the last 24 hours",
      };
    }
    const usd = all.reduce((s, e) => s + e.costUsd!, 0);
    if (usd >= L.maxUsdPer24h) {
      return {
        kind: "limited",
        detail: `US$${usd.toFixed(4)} recorded in the last 24 hours (limit US$${L.maxUsdPer24h})`,
      };
    }
    const next = [...idx.items.values()]
      .filter(
        (it) =>
          !it.settled && !it.drift && it.capture.sample.selected && it.capture.sample.arm !== null,
      )
      .filter(
        (it) =>
          it.capture.question.id === q.ref.id && it.capture.question.version === q.ref.version,
      )
      .filter((it) => !it.attempts.some((e) => e.result === null || TERMINAL.has(e.result.class)))
      .filter((it) => it.attempts.length < L.maxTriesPerItem)
      .filter((it) => {
        const tries = it.attempts.map((e) => Date.parse(e.attempt.at));
        return tries.length === 0 || nowMs - Math.max(...tries) >= L.retryAfterMs;
      })
      .filter((it) => it.capture.sample.arm! < deps.arms.length)
      .sort(
        (a, b) =>
          Date.parse(a.capture.at) - Date.parse(b.capture.at) ||
          (a.capture.itemKey < b.capture.itemKey ? -1 : 1),
      )[0];
    if (!next) return { kind: "idle" };
    if (await deps.spendBlocked(now)) {
      pausedUntil = nowMs + H1_PAUSE.budget;
      return { kind: "paused", until: new Date(pausedUntil).toISOString() };
    }
    const c = next.capture;
    // Pre-call re-check: nothing is spent on an item the operator has acted on,
    // or whose review state is no longer the captured one.
    const pre = await recheck(q, c, cache);
    if (!pre.eligible || !pre.sameState) {
      const reason = pre.eligible ? "state-changed" : `ineligible:${pre.reason}`;
      const lines: NewH1Record[] = [{ kind: "precheck", at, itemKey: c.itemKey, reason }];
      if (pre.eligible && !pre.sameState && pre.digest) {
        lines.unshift({ kind: "drift", at, itemKey: c.itemKey, reviewDigest: pre.digest });
        next.drift = true;
      }
      await deps.ledger.append(lines);
      return { kind: "prechecked", reason };
    }
    const armIndex = c.sample.arm!;
    const arm = deps.arms[armIndex];
    const attemptId = newId("H1A");
    const attempt: NewH1Record = {
      kind: "attempt",
      at,
      attemptId,
      assessmentId: newId("DA"),
      itemKey: c.itemKey,
      config: digest,
      question: q.ref,
      projection: q.projection,
      provider: requestedIdentity(arm.identity()),
      arm: armIndex,
      sample: 0,
      try: next.attempts.length + 1,
      snapshot: c.snapshot.sha256,
    };
    const finish = async (cls: Classified): Promise<H1CallOutcome> => {
      await deps.ledger.append([
        { kind: "result", at: deps.now().toISOString(), attemptId, reconciled: false, ...cls },
      ]);
      await deps.fault?.("result-written");
      if (cls.assessmentId !== null) {
        const post = await recheck(q, c, cache);
        await deps.ledger.append([
          {
            kind: "post-check",
            at: deps.now().toISOString(),
            attemptId,
            eligible: post.eligible,
            sameState: post.sameState,
            reason: post.reason,
          },
        ]);
      }
      const pause = pauseFor(cls);
      if (pause > 0) pausedUntil = nowMs + pause;
      return { kind: "attempted", attemptId };
    };
    const lookup = await deps.snapshots.load(c.snapshot.sha256);
    if (lookup.status !== "retained") {
      await deps.ledger.append([attempt]);
      return finish({
        class: "missing-input",
        providerCalled: "no",
        assessmentId: null,
        outcome: null,
        code: `snapshot-${lookup.status}`,
        detail: bounded(
          lookup.status === "corrupt" ? lookup.detail : "the captured snapshot is not in the store",
        ),
        costUsd: null,
        latencyMs: null,
      });
    }
    // Intent first, fsync'd: after a crash this line is what stops a silent repeat.
    await deps.ledger.append([attempt]);
    invoked = true;
    await deps.fault?.("attempt-written");
    let cls: Classified;
    try {
      const snapshot: StoredSnapshot = lookup.snapshot;
      const res = await deps.service.assessSnapshot({
        question: q.ref.id,
        version: q.ref.version,
        snapshot,
        provider: arm.providerKey,
        sample: 0,
        id: (attempt as H1AttemptRecord).assessmentId,
      });
      cls = classifyServiceResult(res);
    } catch (e) {
      cls = {
        class: "unknown-outcome",
        providerCalled: "unknown",
        assessmentId: null,
        outcome: null,
        code: "error",
        detail: bounded(`the attempt threw: ${(e as Error)?.message ?? String(e)}`),
        costUsd: null,
        latencyMs: null,
      };
    }
    await deps.fault?.("assessed");
    return finish(cls);
  }

  return {
    async check() {
      if (running) return { action: "overlap" };
      invoked = false;
      const en = deps.enablement();
      if (!en.enabled) {
        set("inactive", en.reasons.join("; "));
        return { action: "inactive" };
      }
      running = true;
      try {
        const settings = en.settings;
        const q = resolve();
        if (typeof q === "string") {
          set("halted", q);
          return { action: "halted", detail: q };
        }
        const view = await deps.ledger.load();
        if (isH1Damaged(view)) {
          const first = view.notices.find(
            (n) => n.kind !== "torn-tail" && n.kind !== "recovered-torn-write",
          );
          const detail = `the H1 ledger is damaged (${first?.kind} at line ${first?.line}); deduplication cannot be trusted`;
          set("halted", detail);
          return { action: "halted", detail };
        }
        const at = deps.now().toISOString();
        const cache: GatherCache = {};
        let idx = indexH1(view);
        const pre: NewH1Record[] = [];
        if (!idx.started) pre.push({ kind: "start", at, format: H1_LEDGER_FORMAT, version: 1 });
        const { config, digest } = buildH1Config(
          settings,
          q.ref,
          q.projection,
          deps.arms.map((a) => requestedIdentity(a.identity())),
          deps.snapshots.maxBytes,
        );
        if (idx.configDigests[idx.configDigests.length - 1] !== digest) {
          pre.push({ kind: "config", at, digest, config });
        }
        await deps.ledger.append(pre);
        await reconcile(q, indexH1(await deps.ledger.load()), at, cache);
        idx = indexH1(await deps.ledger.load());
        let verdictMap: Promise<Map<string, Verdict>> | null = null;
        const verdicts = () =>
          (verdictMap ??= deps.sources
            .currentVerdicts()
            .then((vs) => new Map(vs.map((v) => [v.runId, v])))
            .catch(() => new Map<string, Verdict>()));
        const captured = await capture(q, settings, digest, idx, cache, verdicts);
        const settled = await observe(q, settings, idx, cache);
        const outcome = await call(q, settings, digest, idx, cache);
        switch (outcome.kind) {
          case "paused":
            set("paused", "waiting before the next call", outcome.until);
            break;
          case "attempted":
            // Never the result: a pending gate's answer must not show anywhere.
            set(
              pausedUntil > deps.now().getTime() ? "paused" : "waiting",
              "an attempt was recorded",
              pausedUntil > deps.now().getTime() ? new Date(pausedUntil).toISOString() : null,
            );
            break;
          case "idle":
            set("waiting", "nothing to call");
            break;
          case "prechecked":
            set("waiting", "an item was no longer callable");
            break;
          default:
            set("waiting", outcome.detail);
        }
        return { action: "done", captured, settled, call: outcome };
      } catch (e) {
        const detail =
          e instanceof H1LedgerError
            ? `${e.code}: ${e.message}`
            : `H1 collection check failed: ${(e as Error)?.message ?? String(e)}`;
        if (e instanceof H1LedgerError && e.code === "ledger-full") set("halted", detail);
        else set("waiting", detail);
        log.error("h1 collection check failed", { err: e });
        return { action: "error", detail };
      } finally {
        running = false;
      }
    },
    status: () => ({ ...state }),
    invokedLastCheck: () => invoked,
    async spent() {
      return spentFrom(await deps.ledger.read());
    },
  };
}
