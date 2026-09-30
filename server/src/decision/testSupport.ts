import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineInstance, Run } from "@argus/contracts";
import type { KnowledgeLedger } from "../knowledge/kernel.js";
import { builtinRegistry, BUILTIN_BUILDERS } from "./definitions.js";
import { DecisionJournal, type JournalLimits } from "./journal.js";
import type { DecisionSources } from "./projection.js";
import type { DecisionProvider } from "./providers/types.js";
import type { WriteFn } from "./storage.js";
import { createDecisionService } from "./service.js";

/**
 * Fixtures for the Decision Plane tests: fixed clocks, deterministic ids and
 * in-memory sources, so no test touches a real store or the wall clock.
 */

export const T0 = Date.parse("2026-09-01T10:00:00.000Z");
export const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

export function tempRoot(prefix = "argus-decision-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A clock tests can advance. */
export function clock(start = T0 + 3_600_000) {
  let t = start;
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

export function ids(prefix = "DA-test") {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(6, "0")}`;
}

export function failedRun(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "Triage the overnight failures",
    cwd: "/repo",
    status: "failed",
    trigger: "scheduled",
    queuedAt: iso(0),
    startedAt: iso(0),
    endedAt: iso(60_000),
    durationMs: 60_000,
    pid: 100,
    exitCode: 1,
    sessionId: "sess-1",
    project: "-repo",
    resultSummary: "I could not find the config file.",
    error: "exit code 1",
    ...over,
  };
}

export const assistant = (offsetMs: number, content: unknown[]) => ({
  type: "assistant",
  timestamp: iso(offsetMs),
  message: { role: "assistant", content },
});

export const toolResult = (
  offsetMs: number,
  toolUseId: string,
  content: string,
  isError = false,
) => ({
  type: "user",
  timestamp: iso(offsetMs),
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
  },
});

export function transcript(): unknown[] {
  return [
    assistant(5_000, [{ type: "text", text: "Looking for the config." }]),
    assistant(12_000, [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat app.toml" } },
    ]),
    toolResult(20_000, "t1", "cat: app.toml: No such file or directory", true),
    assistant(30_000, [{ type: "text", text: "The config file is missing; stopping." }]),
  ];
}

/** Mutable in-memory sources; every reader returns copies, as the real ones do. */
export function memorySources(
  init: {
    runs?: Run[];
    transcripts?: Record<string, unknown[] | null>;
    instances?: PipelineInstance[];
    ledger?: KnowledgeLedger | null;
  } = {},
) {
  const runs = new Map((init.runs ?? []).map((r) => [r.id, r]));
  const transcripts = new Map(Object.entries(init.transcripts ?? {}));
  const instances = new Map((init.instances ?? []).map((i) => [i.id, i]));
  let ledger = init.ledger ?? null;
  const reads = { runs: 0, transcripts: 0 };
  const sources: DecisionSources = {
    async readRun(id) {
      reads.runs++;
      const r = runs.get(id);
      return r ? structuredClone(r) : null;
    },
    async readTranscript(run) {
      reads.transcripts++;
      if (!transcripts.has(run.id)) return [];
      const t = transcripts.get(run.id);
      return t === null || t === undefined ? null : structuredClone(t);
    },
    async readInstance(id) {
      const i = instances.get(id);
      return i ? structuredClone(i) : null;
    },
    async readLedger() {
      return ledger ? structuredClone(ledger) : null;
    },
    async repositoryState() {
      return null;
    },
  };
  return {
    sources,
    reads,
    runs,
    transcripts,
    instances,
    setLedger(l: KnowledgeLedger | null) {
      ledger = l;
    },
  };
}

export function harness(opts: {
  root?: string;
  providers: Record<string, DecisionProvider>;
  sources?: DecisionSources;
  limits?: Partial<JournalLimits>;
  fault?: (point: string) => void | Promise<void>;
  clock?: ReturnType<typeof clock>;
  newId?: () => string;
  write?: WriteFn;
}) {
  const root = opts.root ?? tempRoot();
  const c = opts.clock ?? clock();
  const journal = new DecisionJournal({
    root,
    limits: opts.limits,
    now: c.now,
    fault: opts.fault,
    write: opts.write,
  });
  const registry = builtinRegistry();
  const mem = memorySources({ runs: [failedRun()], transcripts: { "run-1": transcript() } });
  const sources = opts.sources ?? mem.sources;
  const service = createDecisionService({
    journal,
    registry,
    builders: BUILTIN_BUILDERS,
    sources,
    providers: opts.providers,
    now: c.now,
    newId: opts.newId ?? ids(),
  });
  return { root, clock: c, journal, registry, sources, mem, service };
}

export const RESIDUAL_P = {
  "prompt-ambiguity": 0.05,
  "missing-context": 0.7,
  "tool-misuse": 0.05,
  environment: 0.1,
  "model-refusal": 0,
  "task-infeasible": 0.05,
  other: 0.05,
};
