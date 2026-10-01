import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  GateDecision,
  GateDecisionPrincipal,
  PhaseDef,
  PhaseProgress,
  PhaseReview,
  PipelineDefinition,
  PipelineInstance,
  Run,
  Verdict,
} from "@argus/contracts";
import { createAnalysisRunner, type AnalysisSpawn } from "../../sources/analysis.js";
import { DecisionJournal } from "../journal.js";
import { createClaudeCliProvider } from "../providers/claudeCli.js";
import type { DecisionProvider } from "../providers/types.js";
import { createDecisionService } from "../service.js";
import { ids, memorySources, tempRoot } from "../testSupport.js";
import { countAnalysisPasses } from "../h2/activity.js";
import type { H1Sources } from "./collect.js";
import { h1Enablement } from "./config.js";
import { H1_BUILDERS, h1Registry } from "./definitions.js";
import { H1Ledger } from "./ledger.js";
import { H1SnapshotStore } from "./snapshots.js";
import { createH1Watcher, type H1WatcherDeps, type ShadowSpend } from "./watcher.js";

/**
 * A full H1 collection over temporary stores, for the watcher tests.
 *
 * Real: the H1 ledger and snapshot store, the Decision Journal, the Decision
 * service, the Claude CLI adapter and the `AnalysisRunner` (its busy gate,
 * budget check and disabled switch). Injected: the process spawn, which
 * records every call that would have reached a model, and the gate world —
 * instances, gate decisions, runs and verdicts held in memory, so a test can
 * make the operator act at any exact point.
 */

export const H1_ON = { ARGUS_DECISIONS: "on", ARGUS_DECISIONS_H1_COLLECT: "on" } as const;
export const MIN = 60_000;
export const START = Date.parse("2026-09-01T12:00:00.000Z");
export const at = (offsetMs: number) => new Date(START + offsetMs).toISOString();

export function gateRun(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    scheduleId: "pipeline:p1",
    scheduleName: "Release",
    prompt: "Ship the release notes.",
    cwd: "/work",
    status: "succeeded",
    trigger: "manual",
    queuedAt: at(-10 * MIN),
    startedAt: at(-10 * MIN),
    endedAt: at(-MIN),
    durationMs: 9 * MIN,
    pid: 1,
    exitCode: 0,
    sessionId: `sess-${id}`,
    project: "-work",
    resultSummary: "Wrote NOTES.md.\nARGUS_OUTCOME: succeeded",
    error: null,
    instanceId: "inst-1",
    phaseId: "publish",
    costUsd: 0.12,
    tokens: 3000,
    ...over,
  };
}

export function gatePhaseDef(over: Partial<PhaseDef> = {}): PhaseDef {
  return {
    id: "publish",
    name: "Publish",
    cwd: "/work",
    gated: true,
    steps: [{ name: "ship", prompt: "Ship the release notes." }],
    ...over,
  } as PhaseDef;
}

export function gateInstance(
  opts: {
    id?: string;
    phase?: Partial<PhaseProgress>;
    phaseDef?: Partial<PhaseDef>;
    runIds?: string[];
  } = {},
): PipelineInstance {
  const id = opts.id ?? "inst-1";
  const runIds = opts.runIds ?? ["run-a"];
  const def: PipelineDefinition = {
    id: "p1",
    name: "Release",
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    phases: [gatePhaseDef(opts.phaseDef)],
  } as PipelineDefinition;
  const phase: PhaseProgress = {
    id: "publish",
    name: "Publish",
    gated: true,
    status: "awaiting-approval",
    pause: "gate",
    attempt: 0,
    payload: null,
    steps: runIds.map((r) => ({ name: "ship", runId: r, status: "succeeded" })),
    ...opts.phase,
  };
  return {
    id,
    pipelineId: "p1",
    pipelineName: "Release",
    status: "awaiting-approval",
    currentPhaseIndex: 0,
    phases: [phase],
    trigger: "manual",
    signalToken: "tok",
    createdAt: at(-20 * MIN),
    updatedAt: at(-MIN),
    endedAt: null,
    definition: def,
    gateDecisionIds: [],
  };
}

export function reviewOf(inst: PipelineInstance, phaseId: string): PhaseReview {
  const phase = inst.phases.find((p) => p.id === phaseId)!;
  return {
    instanceId: inst.id,
    phaseId,
    phaseName: phase.name,
    pipelineName: inst.pipelineName,
    status: "awaiting-approval",
    attempt: phase.attempt,
    canApprove: true,
    payload: phase.payload ?? null,
    artifactDir: null,
    artifacts: [],
  };
}

/** The gate world: what the engine and the operator would have written. */
export function gateWorld() {
  const instances = new Map<string, PipelineInstance>();
  const decisions: GateDecision[] = [];
  const runs = new Map<string, Run>();
  let verdicts: Verdict[] = [];
  let n = 0;
  const reads = { instances: 0, decisions: 0 };
  const hooks: {
    afterProject?: () => void;
    review?: (inst: PipelineInstance, phaseId: string) => PhaseReview;
  } = {};
  const world = {
    instances,
    decisions,
    runs,
    reads,
    hooks,
    setVerdicts(v: Verdict[]) {
      verdicts = v;
    },
    put(inst: PipelineInstance) {
      instances.set(inst.id, structuredClone(inst));
      for (const s of inst.phases.flatMap((p) => p.steps)) {
        if (s.runId && !runs.has(s.runId))
          runs.set(s.runId, gateRun(s.runId, { instanceId: inst.id }));
      }
    },
    /** Append a decision record only: what a crash between intent and link leaves. */
    record(
      instanceId: string,
      decision: "approve" | "revise" | "abort",
      over: Partial<GateDecision> = {},
    ): GateDecision {
      const inst = instances.get(instanceId)!;
      const phase = inst.phases[0];
      const d: GateDecision = {
        id: `GD-${++n}`,
        instanceId,
        pipelineId: inst.pipelineId,
        decision,
        mechanism: "operator",
        channel: "http",
        principal: { kind: "session", username: "ops", role: "root" } as GateDecisionPrincipal,
        phases: [
          {
            phaseId: phase.id,
            attempt: phase.attempt,
            status: phase.status,
            runIds: phase.steps.map((s) => s.runId).filter((x): x is string => !!x),
          },
        ],
        recordedAt: at(0),
        ...over,
      };
      decisions.push(d);
      return d;
    },
    /** Link a recorded decision with its pending marker: effects under way. */
    link(d: GateDecision, pending = true) {
      const inst = instances.get(d.instanceId)!;
      inst.gateDecisionIds = [...(inst.gateDecisionIds ?? []), d.id];
      if (pending) {
        inst.pendingGateOperation = {
          decisionId: d.id,
          decision: d.decision,
          phaseId: d.phases[0].phaseId,
          attempt: d.phases[0].attempt,
          stopRunIds: [],
          startedAt: d.recordedAt,
        };
      }
    },
    /** Complete the effects: the gate moves on and the marker is cleared. */
    complete(d: GateDecision) {
      const inst = instances.get(d.instanceId)!;
      delete inst.pendingGateOperation;
      const phase = inst.phases[0];
      if (d.decision === "approve") {
        phase.status = "succeeded";
        inst.status = "succeeded";
      } else if (d.decision === "revise") {
        phase.attempt += 1;
        phase.status = "running";
        phase.steps = phase.steps.map((s) => ({
          ...s,
          runId: `${s.runId}-r${phase.attempt}`,
          status: "running",
        }));
        delete phase.pause;
        inst.status = "running";
      } else {
        phase.status = "aborted";
        inst.status = "aborted";
      }
    },
    /** An operator (or other mechanism) decision, applied in full. */
    act(
      instanceId: string,
      decision: "approve" | "revise" | "abort",
      over: Partial<GateDecision> = {},
    ) {
      const d = world.record(instanceId, decision, over);
      world.link(d);
      world.complete(d);
      return d;
    },
    sources(): H1Sources {
      return {
        async listInstances() {
          return [...instances.values()].map((i) => structuredClone(i));
        },
        async readInstance(id) {
          reads.instances++;
          const i = instances.get(id);
          return i ? structuredClone(i) : null;
        },
        async definitionFor(inst) {
          return inst.definition;
        },
        async readGateDecisions(id) {
          reads.decisions++;
          return decisions.filter((d) => d.instanceId === id).map((d) => structuredClone(d));
        },
        async buildReview(inst, phaseId) {
          const review = hooks.review ? hooks.review(inst, phaseId) : reviewOf(inst, phaseId);
          hooks.afterProject?.();
          return { ok: true, review };
        },
        async readRun(id) {
          const r = runs.get(id);
          return r ? structuredClone(r) : null;
        },
        async watchtower() {
          return {
            anomalies: [],
            baselines: [
              {
                key: "phase:pipeline:p1:publish",
                scope: "phase",
                name: "Publish",
                samples: 20,
                warmupRemaining: 0,
                since: null,
                resetAt: null,
                duration: null,
                cost: null,
                tokens: null,
              },
            ],
          };
        },
        async currentVerdicts() {
          return verdicts.map((v) => structuredClone(v));
        },
        async workingTree() {
          return null;
        },
        async committedSince() {
          return null;
        },
        async numstat() {
          return null;
        },
        async readPhaseBaseline() {
          return null;
        },
        keyOf: () => "phase:pipeline:p1:publish",
      };
    },
  };
  return world;
}

export type Spawned = Parameters<AnalysisSpawn>[0];

const envelope = (result: string, cost: number) =>
  JSON.stringify({ result, total_cost_usd: cost, usage: { input_tokens: 900, output_tokens: 60 } });

export interface H1HarnessOptions {
  env?: Readonly<Record<string, string | undefined>>;
  root?: string;
  /** The model's text for a call. */
  answer?: (prompt: string, call: number) => string;
  costUsd?: number;
  maxLedgerBytes?: number;
  maxSnapshotBytes?: number;
  fault?: H1WatcherDeps["fault"];
  otherSpend?: () => Promise<ShadowSpend[]>;
  /** Called inside the spawn, before it answers: the operator acting mid-call. */
  duringCall?: (call: number) => void;
  world?: ReturnType<typeof gateWorld>;
}

let harnesses = 0;

export function h1Harness(opts: H1HarnessOptions = {}) {
  const root = opts.root ?? tempRoot("argus-h1-");
  let t = START;
  const clock = {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
  const world = opts.world ?? gateWorld();
  const spawns: Spawned[] = [];
  const state = { blocked: false, enabled: true, spendBlocked: false };
  const spawn: AnalysisSpawn = (o) => {
    spawns.push(o);
    const n = spawns.length - 1;
    opts.duringCall?.(n);
    const text = (
      opts.answer ?? (() => JSON.stringify({ p: 0.8, rationale: "a retried attempt" }))
    )(o.prompt, n);
    return {
      kill() {},
      done: Promise.resolve({
        code: 0,
        stdout: envelope(text, opts.costUsd ?? 0.003),
        error: null,
      }),
    };
  };
  const runner = countAnalysisPasses(
    createAnalysisRunner({
      spawn,
      now: clock.now,
      enabled: () => state.enabled,
      blocked: async () => state.blocked,
      meter: async () => {},
    }),
  );
  const cwd = path.join(root, "provider-cwd");
  mkdirSync(cwd, { recursive: true });
  const env = opts.env ?? { ...H1_ON };
  const tag = String(++harnesses).padStart(3, "0");
  const newIds = {
    H1C: ids(`H1C-t${tag}x`),
    H1A: ids(`H1A-t${tag}x`),
    DA: ids(`DA-h1t${tag}x`),
  };
  const registry = h1Registry();

  function boot() {
    const en = h1Enablement(env);
    const journal = new DecisionJournal({ root: path.join(root, "decisions"), now: clock.now });
    const ledger = new H1Ledger({ root: path.join(root, "h1"), maxBytes: opts.maxLedgerBytes });
    const snapshots = new H1SnapshotStore({
      root: path.join(root, "h1"),
      maxBytes: opts.maxSnapshotBytes,
    });
    const providers: Record<string, DecisionProvider> = {};
    const arms = (en.settings?.models ?? [null]).map((model, i) => {
      const p = createClaudeCliProvider({ runner, cwd, ...(model ? { model } : {}) });
      providers[`claude-cli#${i}`] = p;
      return { providerKey: `claude-cli#${i}`, identity: () => p.identity() };
    });
    const service = createDecisionService({
      journal,
      registry,
      builders: H1_BUILDERS,
      sources: memorySources({ runs: [] }).sources,
      providers,
      now: clock.now,
    });
    const watcher = createH1Watcher({
      enablement: () => en,
      ledger,
      snapshots,
      journal,
      service,
      registry,
      arms,
      sources: world.sources(),
      runner,
      spendBlocked: async () => state.spendBlocked,
      ...(opts.otherSpend ? { otherSpend: opts.otherSpend } : {}),
      now: clock.now,
      newId: (prefix) => newIds[prefix](),
      fault: opts.fault,
    });
    return { journal, ledger, snapshots, service, watcher };
  }

  return {
    root,
    clock,
    world,
    spawns,
    state,
    runner,
    registry,
    ...boot(),
    boot,
    /** Advance the clock and run one check. */
    async tick(ms = MIN) {
      clock.advance(ms);
      return this.watcher.check();
    },
    async records() {
      return (await new H1Ledger({ root: path.join(root, "h1") }).read()).records.map(
        (r) => r.record,
      );
    },
  };
}
