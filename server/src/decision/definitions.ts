import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DecisionQuestion, RepositoryStateRef, Run } from "@argus/contracts";
import { paths } from "../claudeHome.js";
import { readLedger } from "../knowledge/store.js";
import { readInstance } from "../sources/instances.js";
import { readRun } from "../sources/runs.js";
import { readSessionLines } from "../sources/sessions.js";
import type { DecisionSources, ProjectionBuilder } from "./projection.js";
import {
  RUN_FAILURE_BLIND_V1,
  RUN_FAILURE_BLIND_V2,
  RUN_FAILURE_V1,
  runFailureBlindBuilder,
  runFailureBlindV2Builder,
  runFailureBuilder,
} from "./projections/runFailure.js";
import { createRegistry, type DecisionRegistry } from "./registry.js";

/**
 * The built-in Phase 1 definitions (RFC §H.2, §O.4) and the default wiring
 * to Argus's real stores.
 *
 * The two H2 questions are different questions: different ids, different
 * answer spaces, different projections, versioned on their own. No observed
 * termination appears among the residual question's options, and the probe's
 * historical V1 options retain their original meaning. V2 separates process
 * endings from tool/task events and uses a transcript-only evaluation input.
 * Neither has a consumer; collection defaults remain explicitly V1. H1 is
 * not registered here.
 */

const humanise = (id: string) => id.replace(/-/g, " ");

export const RESIDUAL_CAUSE_V1: DecisionQuestion = {
  id: "run.failure-cause.residual",
  version: 1,
  text: "Which best explains why this agent run did not accomplish its task?",
  answers: {
    shape: "choice",
    options: [
      "prompt-ambiguity",
      "missing-context",
      "tool-misuse",
      "environment",
      "model-refusal",
      "task-infeasible",
      "other",
    ].map((id) => ({ id, label: humanise(id) })),
    sumTolerance: 0.02,
  },
  subject: "run",
  projection: { id: RUN_FAILURE_V1.id, version: RUN_FAILURE_V1.version },
  consumers: [],
};

export const TERMINATION_PROBE_V1: DecisionQuestion = {
  id: "run.termination-probe",
  version: 1,
  text: "From this trace alone, how did this run end?",
  answers: {
    shape: "choice",
    options: [
      "deadline",
      "never-ran",
      "output-refused",
      "rate-limited",
      "permission-denied",
      "ended-normally",
    ].map((id) => ({ id, label: humanise(id) })),
    sumTolerance: 0.02,
  },
  subject: "run",
  projection: { id: RUN_FAILURE_BLIND_V1.id, version: RUN_FAILURE_BLIND_V1.version },
  consumers: [],
};

export const TERMINATION_PROBE_V2: DecisionQuestion = {
  id: "run.termination-probe",
  version: 2,
  text: "From this transcript evidence alone, how did the process end? Tool failures and task outcome are distinct from process termination: a process may exit normally after either. Abstain when the trace does not establish its ending.",
  answers: {
    shape: "choice",
    options: ["deadline", "never-ran", "ended-normally"].map((id) => ({ id, label: humanise(id) })),
    sumTolerance: 0.02,
  },
  subject: "run",
  projection: { id: RUN_FAILURE_BLIND_V2.id, version: RUN_FAILURE_BLIND_V2.version },
  consumers: [],
};

export const BUILTIN_BUILDERS: readonly ProjectionBuilder[] = [
  runFailureBuilder,
  runFailureBlindBuilder,
  runFailureBlindV2Builder,
];

/** A registry holding every built-in definition, historical versions included. */
export function builtinRegistry(): DecisionRegistry {
  const r = createRegistry();
  r.registerProjection(RUN_FAILURE_V1);
  r.registerProjection(RUN_FAILURE_BLIND_V1);
  r.registerProjection(RUN_FAILURE_BLIND_V2);
  r.registerQuestion(RESIDUAL_CAUSE_V1);
  r.registerQuestion(TERMINATION_PROBE_V1);
  r.registerQuestion(TERMINATION_PROBE_V2);
  return r;
}

/** Where the Decision Journal lives: its own directory, beside (never inside) the other stores. */
export function decisionsRoot(): string {
  return path.join(paths.argus(), "decisions");
}

/** The empty directory the Claude CLI adapter runs in. Outside the journal root. */
export async function providerWorkdir(): Promise<string> {
  const dir = path.join(paths.argus(), "decision-provider-cwd");
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Read-only sources over the real stores. A transcript that should exist (the
 * run has a session) but reads as empty is reported unavailable: the reader
 * cannot tell a pruned transcript from an empty one, and an empty timeline
 * must not hash like a real one.
 */
export function defaultSources(): DecisionSources {
  return {
    readRun: async (id) => (await readRun(id))?.run ?? null,
    async readTranscript(run: Run) {
      if (!run.project || !run.sessionId) return [];
      const lines = await readSessionLines(run.project, run.sessionId);
      return lines.length > 0 ? lines : null;
    },
    readInstance,
    readLedger: async () => readLedger(),
    // Phase 1 projections record no repository state; nothing here observes one.
    repositoryState: async (_subject, _recorded: RepositoryStateRef) => null,
  };
}
