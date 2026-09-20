import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KnowledgeContext, PhaseFailurePayload, PipelineInstance } from "@argus/contracts";
import { createEngine } from "../pipelineEngine.js";
import type { Engine } from "../pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance } from "../sources/instances.js";
import { createClaim, createEvidence, readLedger } from "./store.js";
import { readKnowledgeContext } from "./context.js";
import { qualifyClaimId } from "./scope.js";

/**
 * Knowledge scope through the whole engine: two unrelated projects, one
 * ledger, one Argus.
 *
 * The unit tests prove the kernel and the selectors; this file proves the
 * thing an operator actually cares about — that a pipeline launched against
 * project A resolves its own scope, freezes it on the attempt, materializes a
 * context file containing nothing of project B, and commits what its agent
 * proposes into its own project.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-knowledge-scope-engine-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
});

const NOW = new Date("2026-09-19T10:00:00.000Z");
const A = { projectId: "motorit", repositoryId: "git:github.com/motorit/online" };
const B = { projectId: "acme", repositoryId: "git:github.com/acme/kobra" };
const ruleOf = (scope: typeof A) => qualifyClaimId("RULE-42", scope);

let counter = 0;
function deferred() {
  let resolve!: (v: { code: number | null }) => void;
  const promise = new Promise<{ code: number | null }>((r) => (resolve = r));
  return { promise, resolve };
}

interface Spawned {
  runId: string;
  env: Record<string, string>;
  prompt: string;
}

function recordingSpawn() {
  const calls: Spawned[] = [];
  const spawn = (
    run: { id: string; cwd: string; prompt: string },
    _log: string,
    env: Record<string, string>,
  ) => {
    calls.push({ runId: run.id, env, prompt: run.prompt });
    return { pid: 1000 + calls.length, done: deferred().promise };
  };
  return { spawn, calls };
}

function engine(spawn: ReturnType<typeof recordingSpawn>["spawn"]) {
  return createEngine({
    now: () => new Date(),
    newId: () => `id-${++counter}`,
    spawn,
    signalUrlBase: "http://localhost:7777",
    maxConcurrent: 4,
    tickMs: 30000,
    parentEnv: { PATH: process.env.PATH ?? "/bin", HOME: home },
  });
}

async function seed(
  id: string,
  phases: Record<string, unknown>[],
  over: Record<string, unknown> = {},
) {
  return createPipeline(
    validatePipelineInput({
      name: id,
      trigger: null,
      phases: phases.map((p) => ({ cwd: home, gated: false, ...p })),
      ...over,
    }),
    NOW,
    id,
  );
}

/** Both projects' RULE-42, plus a fact each, all grounded. */
async function seedLedger() {
  for (const scope of [A, B]) {
    await createClaim(
      {
        id: "RULE-42",
        scope,
        kind: "business-rule",
        statement: `${scope.projectId} comments are at most 180`,
      },
      NOW,
    );
    await createEvidence(
      {
        claim: { id: ruleOf(scope), revision: 1 },
        direction: "supports",
        source: { type: "document", uri: `spec://${scope.projectId}` },
      },
      NOW,
    );
  }
}

async function complete(e: Engine, inst: PipelineInstance, phaseId: string, runId: string) {
  return e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId,
    runId,
    type: "completed",
    token: inst.signalToken,
    payload: { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" },
  });
}

async function instance(id: string): Promise<PipelineInstance> {
  const inst = await readInstance(id);
  assert.ok(inst);
  return inst;
}

const step = (over: Record<string, unknown> = {}) => ({
  id: "plan",
  name: "Plan",
  steps: [
    {
      name: "s",
      prompt: "Reason about the comment limit.",
      knowledgeContext: { claims: ["RULE-42"] },
    },
  ],
  ...over,
});

// ── Scope resolution and freezing ───────────────────────────────────────────

test("a declared scope is resolved once and frozen on the phase attempt", async () => {
  await seedLedger();
  await seed("p-a", [step()], { knowledgeScope: { ...A } });
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p-a", "manual"))!;
  const frozen = (await instance(inst.id)).phases[0];
  assert.deepEqual(frozen.knowledgeScope, A);
  assert.equal("knowledgeAlsoRead" in frozen, false);
});

test("a working tree with no derivable repository identity fails the phase, naming the fix", async () => {
  await seedLedger();
  // `home` is a temp directory, not a repository: nothing to derive from, and
  // the directory name is never the answer.
  await seed("p-a", [step()], { knowledgeScope: { projectId: "motorit" } });
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p-a", "manual"))!;
  assert.equal(rec.calls.length, 0);
  const phase = (await instance(inst.id)).phases[0];
  assert.equal(phase.status, "failed");
  const payload = phase.payload as PhaseFailurePayload;
  assert.equal(payload.failureClass, "configuration");
  assert.match(payload.reason ?? "", /Declare knowledgeScope\.repositoryId/);
  // The message names the directory so the failure is diagnosable, but no
  // scope was invented from it: nothing is frozen on the attempt, and the
  // ledger is untouched.
  assert.equal("knowledgeScope" in phase, false);
  assert.equal(
    (await readLedger()).claims.every((c) => c.scope !== undefined),
    true,
  );
});

// ── The agent's context ─────────────────────────────────────────────────────

test("the materialized context for project A holds project A's rule and nothing of project B", async () => {
  await seedLedger();
  await seed("p-a", [step()], { knowledgeScope: { ...A } });
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  await e.start("p-a", "manual");

  const file = rec.calls[0].env.ARGUS_KNOWLEDGE_CONTEXT_FILE;
  const ctx = (await readKnowledgeContext(file)) as KnowledgeContext;
  assert.deepEqual(
    ctx.claims.map((c) => c.ref),
    [`${ruleOf(A)}:v1`],
  );
  assert.deepEqual(ctx.scope, A);
  assert.deepEqual(ctx.claims[0].scope, A);
  assert.equal(ctx.claims[0].statement, "motorit comments are at most 180");
  // What the agent reads, byte for byte, contains no trace of project B.
  const bytes = readFileSync(file, "utf8");
  assert.equal(bytes.includes(ruleOf(B)), false);
  assert.doesNotMatch(bytes, /acme|kobra/i);

  // The same pipeline definition, pointed at project B, gets project B's rule.
  await seed("p-b", [step()], { knowledgeScope: { ...B } });
  await e.start("p-b", "manual");
  const bCtx = (await readKnowledgeContext(
    rec.calls[1].env.ARGUS_KNOWLEDGE_CONTEXT_FILE,
  )) as KnowledgeContext;
  assert.deepEqual(
    bCtx.claims.map((c) => c.ref),
    [`${ruleOf(B)}:v1`],
  );
});

test("a scoped pipeline naming another project's claim refuses to launch", async () => {
  await seedLedger();
  await seed(
    "p-a",
    [
      step({
        steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: [ruleOf(B)] } }],
      }),
    ],
    { knowledgeScope: { ...A } },
  );
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p-a", "manual"))!;
  assert.equal(rec.calls.length, 0);
  const payload = (await instance(inst.id)).phases[0].payload as PhaseFailurePayload;
  assert.equal(payload.failureClass, "configuration");
  assert.match(payload.reason ?? "", /out-of-scope/);
  assert.match(payload.reason ?? "", /alsoRead/);
});

test("an explicitly authorized alsoRead scope launches and is recorded on the attempt", async () => {
  await seedLedger();
  await seed(
    "p-a",
    [
      step({
        steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-42", ruleOf(B)] } }],
      }),
    ],
    { knowledgeScope: { ...A, alsoRead: [B] } },
  );
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p-a", "manual"))!;
  assert.equal(rec.calls.length, 1);
  assert.deepEqual((await instance(inst.id)).phases[0].knowledgeAlsoRead, [B]);
  const ctx = (await readKnowledgeContext(
    rec.calls[0].env.ARGUS_KNOWLEDGE_CONTEXT_FILE,
  )) as KnowledgeContext;
  assert.deepEqual(
    ctx.claims.map((c) => c.ref),
    [`${ruleOf(A)}:v1`, `${ruleOf(B)}:v1`],
  );
  assert.deepEqual(ctx.alsoRead, [B]);
});

// ── What a run commits ──────────────────────────────────────────────────────

function writeDelta(call: Spawned, delta: unknown) {
  const file = call.env.ARGUS_KNOWLEDGE_DELTA_FILE;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(delta));
}

test("a scoped run commits its claims into its own project, with scope-qualified ids", async () => {
  await seedLedger();
  await seed("p-a", [step()], { knowledgeScope: { ...A } });
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p-a", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "motorit drops trailing spaces" }],
    consumed: [{ id: ruleOf(A), revision: 1 }],
  });
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");

  const ledger = await readLedger();
  const created = ledger.claims.find((c) => c.statement.includes("trailing spaces"))!;
  assert.deepEqual(created.scope, A);
  assert.match(created.id, /^RULE-[0-9a-f]{8}\.[0-9a-f]{8}$/);
  // Its consumption is of project A's rule, and project B's ledger is
  // untouched by any of it.
  assert.deepEqual(
    ledger.consumptions.map((k) => k.claim.id),
    [ruleOf(A)],
  );
  assert.equal(ledger.claims.filter((c) => c.id === ruleOf(B)).length, 1);
});

test("a scoped run proposing a revision of another project's rule fails the phase", async () => {
  await seedLedger();
  await seed("p-a", [step()], { knowledgeScope: { ...A } });
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p-a", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    revisions: [{ claimId: ruleOf(B), expectedRevision: 1, statement: "at most 500" }],
  });
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();

  const phase = (await instance(inst.id)).phases[0];
  assert.equal(phase.status, "failed");
  assert.match(JSON.stringify(phase.payload), /scope/);
  // And nothing landed: project B's rule is still at v1.
  const ledger = await readLedger();
  assert.deepEqual(
    ledger.claims.filter((c) => c.id === ruleOf(B)).map((c) => c.revision),
    [1],
  );
});

test("an unscoped pipeline against the same ledger sees and writes only unscoped knowledge", async () => {
  await seedLedger();
  await createClaim({ id: "RULE-LEGACY", kind: "business-rule", statement: "legacy" }, NOW);
  await seed("p-legacy", [
    step({
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-LEGACY"] } }],
    }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p-legacy", "manual"))!;
  const ctx = (await readKnowledgeContext(
    rec.calls[0].env.ARGUS_KNOWLEDGE_CONTEXT_FILE,
  )) as KnowledgeContext;
  assert.deepEqual(
    ctx.claims.map((c) => c.ref),
    ["RULE-LEGACY:v1"],
  );
  assert.equal("scope" in ctx, false);
  assert.equal("knowledgeScope" in (await instance(inst.id)).phases[0], false);

  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "fact", statement: "a legacy fact" }],
  });
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();
  const ledger = await readLedger();
  const created = ledger.claims.find((c) => c.statement === "a legacy fact")!;
  assert.equal("scope" in created, false);
  assert.match(created.id, /^FACT-[0-9a-f]{8}$/);
});

// ── Phase-level overrides: two projects inside one instance ─────────────────

test("phases of one instance resolve and freeze their own scopes independently", async () => {
  await seedLedger();
  // Two phases of one pipeline, deliberately in two different projects — the
  // shape that makes a cross-scope `changeContext` possible at all. Each phase
  // resolves its own scope; the guard that stops the second phase reading the
  // first's accepted intent is proven directly in isolation.test.ts, against a
  // ledger that actually holds an accepted proposal.
  await seed("p-mixed", [
    {
      id: "intent",
      name: "Intent",
      gated: true,
      knowledgeScope: { ...A },
      changeIntent: { request: { id: "CR-1", summary: "raise the limit" } },
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-42"] } }],
    },
    {
      id: "implement",
      name: "Implement",
      needs: ["intent"],
      knowledgeScope: { ...B },
      changeContext: { fromPhase: "intent" },
      steps: [{ name: "s", prompt: "p" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p-mixed", "manual"))!;
  // The first phase is scoped to A and resolves normally.
  assert.deepEqual((await instance(inst.id)).phases[0].knowledgeScope, A);

  // Only the first phase has launched (the second waits on its gate), and the
  // scope it froze is its own rather than the pipeline's or its successor's.
  assert.equal(rec.calls.length, 1);
  const ctx = (await readKnowledgeContext(
    rec.calls[0].env.ARGUS_KNOWLEDGE_CONTEXT_FILE,
  )) as KnowledgeContext;
  assert.deepEqual(ctx.scope, A);
  assert.deepEqual(
    ctx.claims.map((c) => c.ref),
    [`${ruleOf(A)}:v1`],
  );
});

test("the change-proposals listing can be narrowed to one project", async () => {
  await seedLedger();
  const { recordChangeProposal } = await import("./kernel.js");
  const { mutateLedger } = await import("./store.js");
  for (const [id, scope] of [
    ["CP-A", A],
    ["CP-B", B],
  ] as const) {
    await mutateLedger((ledger) => {
      const r = recordChangeProposal(
        ledger,
        {
          id,
          request: { id: `CR-${id}`, summary: "s" },
          execution: { runId: `run-${id}`, instanceId: "i", phaseId: "intent" },
          readiness: "ready",
          semanticChanges: [],
          revised: [],
          created: [],
          decisions: [],
          constraints: [],
          preserved: [{ id: ruleOf(scope), revision: 1 }],
          acceptanceCriteria: [],
          unresolved: [],
          classification: [],
        },
        NOW.toISOString(),
      );
      return { ledger: r.ledger, result: r.proposal };
    });
  }
  const { knowledgeRoutes } = await import("./routes.js");
  const routes = knowledgeRoutes();
  const read = async (q: string) =>
    (await (await routes.request(`/change-proposals${q}`)).json()) as {
      proposals: Array<{ id: string }>;
    };
  assert.deepEqual((await read("")).proposals.map((p) => p.id).sort(), ["CP-A", "CP-B"]);
  assert.deepEqual(
    (
      await read(
        `?project=${encodeURIComponent(A.projectId)}&repository=${encodeURIComponent(A.repositoryId)}`,
      )
    ).proposals.map((p) => p.id),
    ["CP-A"],
  );
});
