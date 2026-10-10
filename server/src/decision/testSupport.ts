import { mkdtempSync, realpathSync } from "node:fs";
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

/**
 * Every spelling under which the directory `home` can appear in persisted
 * state or a response body, longest first: as given, through its real path
 * (Windows can hand out an 8.3 short temp path such as `RUNNER~1` whose long
 * form is what a resolved path shows), with forward slashes, and with the
 * backslashes JSON escapes. On POSIX these collapse to the one string `home`.
 */
export function homeSpellings(home: string): string[] {
  const roots = new Set([home]);
  try {
    roots.add(realpathSync.native(home));
  } catch {
    /* gone already: its given spelling is the only one */
  }
  const out = new Set<string>();
  for (const root of roots) {
    out.add(root);
    out.add(root.split("\\").join("/"));
    out.add(JSON.stringify(root).slice(1, -1));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * `text` with each spelling of the scenario's own `home` directory replaced by
 * `<HOME>`, so two runs in two temp homes compare equal on everything else.
 * Only the exact home strings are replaced — never a pattern — so a path that
 * differs anywhere below the home still differs.
 */
export function withoutHome(text: string, home: string): string {
  return homeSpellings(home).reduce((acc, spelling) => acc.split(spelling).join("<HOME>"), text);
}

/**
 * An instance journal (`argus/journals/<id>.jsonl`) with the entries that share
 * one `at` put in a fixed order, for comparing two runs of the same scenario.
 *
 * The engine writes journal entries fire-and-forget (`void journal(…)`), and
 * each append awaits its own directory and size checks before writing, so two
 * entries queued in the same instant (a `route.selection` and the
 * `route.skip`s it caused) can land in either order. That is pre-existing
 * engine behaviour, and it varies from run to run with collection on or off.
 * Every line is still compared, and so is the order across instants; only the
 * order among same-instant entries is not.
 */
export function settleJournalOrder(relPath: string, text: string): string {
  // A pipeline transition log records the instance's definition (and every
  // state) by SHA-256, and the definition carries wall-clock stamps and a
  // temp-dir cwd the comparison replaces in plain text — but cannot replace
  // inside a digest. Every other byte of the log is still compared.
  if (/(^|[\\/])transitions[\\/][^\\/]+\.jsonl$/.test(relPath)) {
    return text.replace(/[0-9a-f]{64}/g, "<DIGEST>");
  }
  // Either separator: `relPath` comes from `path.relative`, native on Windows.
  if (!/(^|[\\/])journals[\\/][^\\/]+\.jsonl$/.test(relPath)) return text;
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  const at = (l: string) => {
    try {
      return String((JSON.parse(l) as { at?: unknown }).at);
    } catch {
      return l;
    }
  };
  const out: string[] = [];
  let group: string[] = [];
  for (const l of lines) {
    if (group.length > 0 && at(group[0]) !== at(l)) {
      out.push(...group.sort());
      group = [];
    }
    group.push(l);
  }
  out.push(...group.sort());
  return [...out, tail].join("\n");
}
