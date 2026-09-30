import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  DecisionProjection,
  DecisionQuestion,
  PipelineInstance,
  RepositoryStateRef,
} from "@argus/contracts";
import type { KnowledgeLedger } from "../knowledge/kernel.js";
import { deriveCurrency } from "./currency.js";
import { BUILTIN_BUILDERS, builtinRegistry, RESIDUAL_CAUSE_V1 } from "./definitions.js";
import { DecisionJournal } from "./journal.js";
import type { DecisionSources, ProjectionBuilder } from "./projection.js";
import { createMockProvider } from "./providers/mock.js";
import { createRegistry } from "./registry.js";
import { RUN_FAILURE_V1 } from "./projections/runFailure.js";
import { createDecisionService } from "./service.js";
import {
  clock,
  ids,
  memorySources,
  RESIDUAL_P,
  tempRoot,
  transcript,
  failedRun,
} from "./testSupport.js";

const answering = () => createMockProvider({ script: () => ({ distribution: RESIDUAL_P }) });

async function residualSetup() {
  const mem = memorySources({ runs: [failedRun()], transcripts: { "run-1": transcript() } });
  const registry = builtinRegistry();
  const journal = new DecisionJournal({ root: tempRoot(), now: clock().now });
  const service = createDecisionService({
    journal,
    registry,
    builders: BUILTIN_BUILDERS,
    sources: mem.sources,
    providers: { mock: answering() },
    newId: ids(),
  });
  const r = await service.assess({
    question: "run.failure-cause.residual",
    subject: { kind: "run", runId: "run-1" },
    provider: "mock",
  });
  assert.ok(r.ok);
  const deps = { registry, builders: BUILTIN_BUILDERS, sources: mem.sources, journal };
  return { mem, registry, journal, deps, a: r.assessment };
}

const statusOf = (c: Awaited<ReturnType<typeof deriveCurrency>>, check: string) =>
  c.checks.find((x) => x.check === check)?.status;

test("a fresh assessment of an unchanged finished run is current", async () => {
  const { a, deps } = await residualSetup();
  const c = await deriveCurrency(a, deps);
  assert.equal(c.status, "current", JSON.stringify(c.checks));
  for (const k of [
    "question-definition",
    "question-version",
    "projection-definition",
    "snapshot",
    "subject",
  ]) {
    assert.equal(statusOf(c, k), "current", k);
  }
});

test("a newer question version makes it stale; the historical record is not rewritten", async () => {
  const { a, deps, journal } = await residualSetup();
  const before = (await journal.read()).entries[0].digest;
  deps.registry.registerQuestion({ ...RESIDUAL_CAUSE_V1, version: 2, text: "Why did it fail?" });
  const c = await deriveCurrency(a, deps);
  assert.equal(c.status, "stale");
  assert.equal(statusOf(c, "question-version"), "stale");
  assert.equal((await journal.read()).entries[0].digest, before);
});

test("a changed source makes it stale; a missing source never reads as current", async () => {
  const { a, deps, mem } = await residualSetup();
  mem.transcripts.set("run-1", [...transcript(), ...transcript()]);
  const changed = await deriveCurrency(a, deps);
  assert.equal(changed.status, "stale");
  assert.equal(statusOf(changed, "snapshot"), "stale");

  mem.transcripts.set("run-1", null);
  const noTranscript = await deriveCurrency(a, deps);
  assert.equal(noTranscript.status, "unavailable");
  assert.equal(statusOf(noTranscript, "snapshot"), "unavailable");

  mem.transcripts.set("run-1", transcript());
  mem.runs.delete("run-1");
  const noRun = await deriveCurrency(a, deps);
  assert.equal(noRun.status, "unavailable");
  assert.equal(statusOf(noRun, "subject"), "unavailable");
});

test("a definition edited without a version bump is unavailable, not current", async () => {
  const { a, deps } = await residualSetup();
  const edited = createRegistry();
  edited.registerProjection(RUN_FAILURE_V1);
  edited.registerQuestion({ ...RESIDUAL_CAUSE_V1, text: "Silently reworded." });
  const c = await deriveCurrency(a, { ...deps, registry: edited });
  assert.equal(c.status, "unavailable");
  assert.equal(statusOf(c, "question-definition"), "unavailable");

  const noProjection = createRegistry();
  const c2 = await deriveCurrency(a, { ...deps, registry: noProjection });
  assert.equal(c2.status, "unavailable");
});

// A test-only projection over a phase attempt that references a claim revision
// and records a repository state, to exercise the subject, claim and
// repository checks.
const GATE_TEST: DecisionProjection = {
  id: "gate-test",
  version: 1,
  subject: "phase-attempt",
  description: "test only",
  maxBytes: 4096,
  redactionRules: [],
  truncation: { rule: "none", caps: {} },
  withheld: [],
};
const GATE_Q: DecisionQuestion = {
  id: "gate.test-question",
  version: 1,
  text: "Test?",
  answers: { shape: "binary" },
  subject: "phase-attempt",
  projection: { id: "gate-test", version: 1 },
  consumers: [],
};
const gateBuilder: ProjectionBuilder = {
  id: "gate-test",
  version: 1,
  async project(_def, subject, sources) {
    if (subject.kind !== "phase-attempt")
      return { ok: false, reason: "subject-mismatch", detail: "" };
    const inst = await sources.readInstance(subject.instanceId);
    const phase = inst?.phases.find((p) => p.id === subject.phaseId);
    if (!inst || !phase || phase.attempt !== subject.attempt) {
      return { ok: false, reason: "source-unavailable", detail: "attempt not current" };
    }
    return {
      ok: true,
      content: {
        subject,
        repository: { gitHead: "abc1234" },
        refs: { runs: [], claims: [{ id: "R1", revision: 1 }], verifications: [], artifacts: [] },
        subjectAuthored: [],
        redactions: [],
        truncations: [],
        body: { phase: phase.id, attempt: phase.attempt },
      },
    };
  },
};

function instance(attempt: number): PipelineInstance {
  return { id: "inst-1", phases: [{ id: "build", attempt }] } as unknown as PipelineInstance;
}
const ledgerWith = (revision: number) =>
  ({
    claims: [{ id: "R1", revision }],
    verifications: [],
    acceptanceVerifications: [],
  }) as unknown as KnowledgeLedger;

async function gateSetup() {
  const mem = memorySources({ instances: [instance(1)], ledger: ledgerWith(1) });
  let repo: RepositoryStateRef | null = { gitHead: "abc1234" };
  const sources: DecisionSources = { ...mem.sources, repositoryState: async () => repo };
  const registry = createRegistry();
  registry.registerProjection(GATE_TEST);
  registry.registerQuestion(GATE_Q);
  const journal = new DecisionJournal({ root: tempRoot(), now: clock().now });
  const service = createDecisionService({
    journal,
    registry,
    builders: [gateBuilder],
    sources,
    providers: { mock: createMockProvider({ script: () => ({ distribution: 0.2 }) }) },
    newId: ids(),
  });
  const r = await service.assess({
    question: "gate.test-question",
    subject: { kind: "phase-attempt", instanceId: "inst-1", phaseId: "build", attempt: 1 },
    provider: "mock",
  });
  assert.ok(r.ok, JSON.stringify(r));
  return {
    a: r.assessment,
    mem,
    deps: { registry, builders: [gateBuilder], sources, journal },
    setRepo: (r: RepositoryStateRef | null) => {
      repo = r;
    },
  };
}

test("a phase-attempt assessment is current while the attempt stands and stale once the attempt changes", async () => {
  const { a, deps, mem } = await gateSetup();
  assert.equal((await deriveCurrency(a, deps)).status, "current");
  mem.instances.set("inst-1", instance(2));
  const c = await deriveCurrency(a, deps);
  assert.equal(c.status, "stale");
  assert.equal(statusOf(c, "subject"), "stale");
  mem.instances.delete("inst-1");
  const gone = await deriveCurrency(a, deps);
  assert.equal(gone.status, "unavailable");
  assert.equal(statusOf(gone, "subject"), "unavailable");
});

test("referenced claim revisions and repository state bind currency", async () => {
  const { a, deps, mem, setRepo } = await gateSetup();
  mem.setLedger(ledgerWith(2));
  const superseded = await deriveCurrency(a, deps);
  assert.equal(statusOf(superseded, "claim-revisions"), "stale");
  assert.equal(superseded.status, "stale");

  mem.setLedger(null);
  const noLedger = await deriveCurrency(a, deps);
  assert.equal(statusOf(noLedger, "claim-revisions"), "unavailable");
  assert.equal(noLedger.status, "unavailable");

  mem.setLedger({
    claims: [],
    verifications: [],
    acceptanceVerifications: [],
  } as unknown as KnowledgeLedger);
  assert.equal(statusOf(await deriveCurrency(a, deps), "claim-revisions"), "unavailable");

  mem.setLedger(ledgerWith(1));
  setRepo({ gitHead: "def5678" });
  const moved = await deriveCurrency(a, deps);
  assert.equal(statusOf(moved, "repository-state"), "stale");
  setRepo(null);
  const unknown = await deriveCurrency(a, deps);
  assert.equal(statusOf(unknown, "repository-state"), "unavailable");
  assert.equal(unknown.status, "unavailable");
  setRepo({ gitHead: "abc1234" });
  assert.equal((await deriveCurrency(a, deps)).status, "current");
});

test("deriving currency writes nothing", async () => {
  const { a, deps, journal } = await residualSetup();
  const snap = () =>
    walk(journal.layout.root).map((f) => [f, statSync(f).size, readFileSync(f, "utf8")]);
  const before = snap();
  deps.registry.registerQuestion({ ...RESIDUAL_CAUSE_V1, version: 2, text: "Why?" });
  await deriveCurrency(a, deps);
  assert.deepEqual(snap(), before);
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else out.push(f);
  }
  return out.sort();
}
