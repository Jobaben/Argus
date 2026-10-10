import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Run } from "@argus/contracts";
import { createAnalysisRunner, type AnalysisSpawn } from "../../sources/analysis.js";
import { BUILTIN_BUILDERS, builtinRegistry } from "../definitions.js";
import { DecisionJournal, type JournalLimits } from "../journal.js";
import { createCodexCliProvider } from "../providers/codexCli.js";
import { createClaudeCliProvider } from "../providers/claudeCli.js";
import { createDecisionService } from "../service.js";
import { failedRun, ids, memorySources, RESIDUAL_P, tempRoot, transcript } from "../testSupport.js";
import { countAnalysisPasses } from "./activity.js";
import { h2Enablement } from "./config.js";
import { CollectionLedger } from "./ledger.js";
import { createH2Watcher, type H2WatcherDeps } from "./watcher.js";

/**
 * A full H2 collection over temporary stores, for the watcher tests.
 *
 * Everything real except the process spawn: the Decision Journal, the
 * collection ledger, the Decision service, the Claude CLI adapter, and the
 * `AnalysisRunner` with its own busy gate, budget check and disabled switch.
 * No CLI is started and nothing is paid for; `spawns` records every call that
 * would have reached a model.
 */

export const ON = { ARGUS_DECISIONS: "on", ARGUS_DECISIONS_H2_COLLECT: "on" } as const;

export const PROBE_P = {
  deadline: 0.8,
  "never-ran": 0.02,
  "output-refused": 0.02,
  "rate-limited": 0.03,
  "permission-denied": 0.03,
  "ended-normally": 0.1,
};

export const MIN = 60_000;
/** Where every harness clock starts: collection starts here on the first enabled check. */
export const START = Date.parse("2026-09-01T12:00:00.000Z");
export const at = (offsetMs: number) => new Date(START + offsetMs).toISOString();

/** A finished run that ended `offsetMs` after the harness start. */
export function endedRun(id: string, offsetMs: number, over: Partial<Run> = {}): Run {
  return failedRun({
    id,
    sessionId: `sess-${id}`,
    queuedAt: at(offsetMs - 60_000),
    startedAt: at(offsetMs - 60_000),
    endedAt: at(offsetMs),
    ...over,
  });
}

export type Spawned = Parameters<AnalysisSpawn>[0];

const envelope = (result: string, cost: number | null) =>
  JSON.stringify({ result, total_cost_usd: cost, usage: { input_tokens: 900, output_tokens: 60 } });

export function defaultAnswer(prompt: string): string {
  return JSON.stringify({ p: prompt.includes("how did this run end") ? PROBE_P : RESIDUAL_P });
}

export interface H2HarnessOptions {
  runs?: Run[];
  transcripts?: Record<string, unknown[] | null>;
  env?: Readonly<Record<string, string | undefined>>;
  /** The model's text for a call; defaults to a valid answer for either question. */
  answer?: (prompt: string, call: number) => string;
  costUsd?: number | null;
  root?: string;
  journalLimits?: Partial<JournalLimits>;
  maxLedgerBytes?: number;
  fault?: H2WatcherDeps["fault"];
  model?: string;
  questions?: H2WatcherDeps["questions"];
  otherSpend?: H2WatcherDeps["otherSpend"];
  registry?: ReturnType<typeof builtinRegistry>;
  /** Hold every spawn until `release()` is called. */
  hold?: boolean;
}

let harnesses = 0;

export function h2Harness(opts: H2HarnessOptions = {}) {
  const root = opts.root ?? tempRoot("argus-h2-");
  let t = START;
  const clock = {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
  const runs = opts.runs ?? [endedRun("run-1", MIN)];
  const transcripts =
    opts.transcripts ?? Object.fromEntries(runs.map((r) => [r.id, transcript()] as const));
  const mem = memorySources({ runs, transcripts });
  const spawns: Spawned[] = [];
  const state = { blocked: false, enabled: true, metered: 0, runReads: 0 };
  let releases: Array<() => void> = [];
  const spawn: AnalysisSpawn = (o) => {
    spawns.push(o);
    const n = spawns.length - 1;
    const answer = (opts.answer ?? defaultAnswer)(o.prompt, n);
    const stdout =
      o.runtime === "codex"
        ? [
            JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: answer },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: { input_tokens: 900, output_tokens: 60 },
            }),
          ].join("\n")
        : envelope(answer, opts.costUsd === undefined ? 0.002 : opts.costUsd);
    const done = opts.hold
      ? new Promise<{ code: number; stdout: string; error: null }>((resolve) =>
          releases.push(() => resolve({ code: 0, stdout, error: null })),
        )
      : Promise.resolve({ code: 0, stdout, error: null });
    return { kill() {}, done };
  };
  const inner = createAnalysisRunner({
    spawn,
    now: clock.now,
    enabled: () => state.enabled,
    blocked: async () => state.blocked,
    meter: async () => {
      state.metered++;
    },
  });
  const runner = countAnalysisPasses(inner);
  const cwd = path.join(root, "provider-cwd");
  mkdirSync(cwd, { recursive: true });
  const registry = opts.registry ?? builtinRegistry();
  const env = opts.env ?? { ...ON };
  // Unique per harness: two harnesses over one root are two processes, and
  // real ids never repeat across processes.
  const tag = String(++harnesses).padStart(3, "0");
  const newIds = ids(`DA-h2t${tag}x`);
  const attemptIds = ids(`H2A-t${tag}x`);

  /** A fresh set of objects over the same files: what a restarted process would build. */
  function boot() {
    const journal = new DecisionJournal({
      root: path.join(root, "decisions"),
      now: clock.now,
      limits: opts.journalLimits,
    });
    const ledger = new CollectionLedger({
      root: path.join(root, "h2"),
      maxBytes: opts.maxLedgerBytes,
    });
    const settings = h2Enablement(env).settings;
    const factory =
      settings?.runtime === "codex" ? createCodexCliProvider : createClaudeCliProvider;
    const provider = factory({
      runner,
      cwd,
      ...((opts.model ?? settings?.model) ? { model: opts.model ?? settings!.model! } : {}),
      ...(settings?.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    });
    const service = createDecisionService({
      journal,
      registry,
      builders: BUILTIN_BUILDERS,
      sources: mem.sources,
      providers: { [provider.kind]: provider },
      now: clock.now,
    });
    const watcher = createH2Watcher({
      enablement: () => h2Enablement(env),
      ledger,
      journal,
      service,
      registry,
      questions: opts.questions,
      otherSpend: opts.otherSpend,
      providerKey: provider.kind,
      providerIdentity: () => provider.identity(),
      readRuns: async () => {
        state.runReads++;
        return [...mem.runs.values()].map((r) => structuredClone(r));
      },
      runner,
      spendBlocked: async () => state.blocked,
      now: clock.now,
      newAttemptId: attemptIds,
      newAssessmentId: newIds,
      fault: opts.fault,
    });
    return { journal, ledger, service, watcher, provider };
  }

  const booted = boot();
  return {
    root,
    clock,
    mem,
    spawns,
    state,
    runner,
    inner,
    registry,
    ...booted,
    boot,
    ledgerFile: path.join(root, "h2", "collection.jsonl"),
    /** Resolve once `n` spawns have been made (real time; the harness clock is untouched). */
    async spawned(n: number) {
      for (let i = 0; i < 2000 && spawns.length < n; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      if (spawns.length < n) throw new Error(`expected ${n} spawns, saw ${spawns.length}`);
    },
    release() {
      const r = releases;
      releases = [];
      for (const f of r) f();
    },
    /** Run one check and return the ledger records it appended. */
    async records() {
      return (await boot().ledger.read()).records.map((r) => r.record);
    },
  };
}
