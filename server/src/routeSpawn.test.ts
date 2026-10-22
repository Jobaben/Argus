import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { createEngine, type ActionResult, type Engine } from "./pipelineEngine.js";
import { fakeKill } from "./testPlatform.js";
import { testRunToken } from "./testSignalToken.js";
import { createUserStore } from "./userStore.js";
import { isTerminal } from "./sources/instanceStatus.js";
import { readInstance, writeInstance } from "./sources/instances.js";
import type { ArgusConfig } from "./config.js";
import type { AuthService } from "./auth.js";
import type {
  InstanceStatus,
  PhaseDef,
  PhaseProgress,
  PhaseReview,
  PipelineDefinition,
  PipelineInstance,
  SpawnTask,
} from "./sources/pipelineTypes.js";

/**
 * Spawn phases over HTTP (DL-A2a), on existing routes only: listing the
 * children one parent spawned (`?parent=`), the refusal codes approve and
 * revise forward, the edit guard that also holds a pipeline a live parent
 * still spawns, and the gate review of a spawn phase.
 *
 * The routes' own contract runs over a fake engine. The two refusals a client
 * acts on (`parent-decided`, `answers-not-accepted`) run over the real engine,
 * on records written by hand as an earlier decision or a crash would leave
 * them. Its spawn double starts no process: the pid is invented, so `kill` is
 * the fake one.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-route-spawn-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
});

// Every real engine is drained before the next test repoints the home.
const engines: Engine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.drain()));
});

const config: ArgusConfig = {
  port: 7777,
  host: "127.0.0.1",
  token: null,
  allowedHosts: [],
  allowedOrigins: [],
  maxConcurrentRuns: 4,
  schedulerTickMs: 30000,
  webhookUrl: null,
};

const fakeEngine: Engine = {
  start: async () => null,
  onSignal: async () => ({ ok: true, code: 200 }),
  approve: async () => ({ ok: true, code: 200 }),
  approveAutomatically: async () => ({ ok: true as const, code: 200 }),
  revise: async () => ({ ok: true, code: 200 }),
  abort: async () => ({ ok: true, code: 200 }),
  withStartsHeld: (_pipelineId, work) => work(),
  reconcile: async () => {},
  pollGates: async () => {},
  stopPolls: () => {},
  adopt: async () => {},
  drain: async () => {},
};

const openAuth: AuthService = {
  isConfigured: async () => true,
  status: async () => ({ configured: true, username: "test", role: "root" }),
  login: async () => ({ ok: false, reason: "bad-credentials" }),
  verify: () => ({ username: "test", role: "root" }),
  logout: () => {},
  revokeSessions: () => {},
};

function makeApp(engine: Engine = fakeEngine) {
  return createApp({
    config,
    engine,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth: openAuth,
  });
}

let counter = 0;
/** The routes over a real engine whose steps never finish. */
function appWithEngine() {
  const engine = createEngine({
    now: () => new Date(),
    newId: () => `id-${++counter}`,
    spawn: () => ({ pid: 4242, done: new Promise<{ code: number | null }>(() => {}) }),
    signalUrlBase: "http://127.0.0.1:7777",
    newSignalToken: testRunToken,
    maxConcurrent: 32,
    kill: fakeKill().kill,
  });
  engines.push(engine);
  return makeApp(engine);
}

const loopback = { host: "localhost:7777" };
const sameOrigin = {
  host: "localhost:7777",
  origin: "http://localhost:7777",
  "content-type": "application/json",
};

const AT = "2026-10-21T09:00:00.000Z";

function phaseDef(id: string, over: Partial<PhaseDef> = {}): PhaseDef {
  return { id, name: id, cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }], ...over };
}

/** `plan`, the spawn phase `tasks` (one instance of `target` per task), `ship`. */
function deliveryDef(target: string): PipelineDefinition {
  return {
    id: "delivery",
    name: "Delivery",
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: AT,
    updatedAt: AT,
    phases: [
      phaseDef("plan", { gated: true }),
      phaseDef("tasks", {
        steps: [],
        needs: ["plan"],
        spawn: { pipelineId: target, items: { phase: "plan", path: ["tasks"] }, key: "id" },
      }),
      phaseDef("ship", { needs: ["tasks"] }),
    ],
  };
}

/** The task pipeline `T`: one gated phase, `pr`. */
function taskDef(): PipelineDefinition {
  return {
    ...deliveryDef("T"),
    id: "T",
    name: "Task",
    overlapPolicy: "allow",
    phases: [phaseDef("pr", { name: "PR", gated: true })],
  };
}

function progress(
  id: string,
  status: PhaseProgress["status"],
  over: Partial<PhaseProgress> = {},
): PhaseProgress {
  return { id, name: id, gated: false, status, steps: [], attempt: 1, payload: null, ...over };
}

/** An instance record as the engine would have saved it. */
function instance(
  over: Partial<PipelineInstance> & Pick<PipelineInstance, "id" | "pipelineId" | "status">,
): PipelineInstance {
  return {
    pipelineName: over.pipelineId,
    currentPhaseIndex: 0,
    phases: [],
    trigger: "manual",
    signalToken: "tok",
    createdAt: AT,
    updatedAt: AT,
    endedAt: isTerminal(over.status) ? AT : null,
    ...over,
  };
}

/** The parent `P` of `delivery`: `plan` succeeded, its spawn phase as given. */
function writeParent(status: InstanceStatus, tasks: PhaseProgress) {
  return writeInstance(
    instance({
      id: "P",
      pipelineId: "delivery",
      status,
      currentPhaseIndex: 1,
      definition: deliveryDef("T"),
      phases: [progress("plan", "succeeded", { gated: true }), tasks, progress("ship", "pending")],
    }),
  );
}

/** The spawn phase `tasks` of `P`, with these tasks of pipeline `T`. */
function tasksPhase(
  status: PhaseProgress["status"],
  tasks: SpawnTask[],
  over: Partial<PhaseProgress> = {},
): PhaseProgress {
  return progress("tasks", status, {
    children: { pipelineId: "T", source: { phaseId: "plan", attempt: 1 }, maxParallel: 1, tasks },
    ...over,
  });
}

/** A child of `T` spawned by `parentId` for task `a`, waiting at its gate `pr`. */
function writeChild(id: string, parentId = "P") {
  return writeInstance(
    instance({
      id,
      pipelineId: "T",
      pipelineName: "Task",
      status: "awaiting-approval",
      trigger: "spawned",
      parent: {
        instanceId: parentId,
        pipelineId: "delivery",
        phaseId: "tasks",
        index: 0,
        key: "a",
      },
      definition: taskDef(),
      phases: [
        progress("pr", "awaiting-approval", {
          name: "PR",
          gated: true,
          pause: "gate",
          steps: [{ name: "s", runId: `${id}-run`, status: "succeeded" }],
        }),
      ],
    }),
  );
}

async function post(app: ReturnType<typeof makeApp>, url: string, body: unknown = {}) {
  const res = await app.request(url, {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function gateDecisions(app: ReturnType<typeof makeApp>, id: string): Promise<unknown[]> {
  const res = await app.request(`/api/instances/${id}/gate-decisions`, { headers: loopback });
  assert.equal(res.status, 200, `the decisions of ${id} are readable`);
  return ((await res.json()) as { decisions: unknown[] }).decisions;
}

// ── ?parent= ─────────────────────────────────────────────────────────────────

test("?parent= lists the instances one parent spawned, newest first", async () => {
  const app = makeApp();
  const child = (id: string, parentId: string, createdAt: string, pipelineId = "T") =>
    writeInstance(
      instance({
        id,
        pipelineId,
        status: "running",
        trigger: "spawned",
        createdAt,
        parent: {
          instanceId: parentId,
          pipelineId: "delivery",
          phaseId: "tasks",
          index: 0,
          key: id,
        },
      }),
    );
  await child("c1", "P1", "2026-10-21T09:00:00.000Z");
  await child("c2", "P1", "2026-10-21T10:00:00.000Z");
  await child("c3", "P2", "2026-10-21T11:00:00.000Z");
  // P1's child of another pipeline lives under that pipeline's id.
  await child("c4", "P1", "2026-10-21T12:00:00.000Z", "other");
  await writeInstance(
    instance({ id: "m1", pipelineId: "T", status: "succeeded", createdAt: "2026-10-21T08:00:00Z" }),
  );
  const ids = async (query: string) => {
    const res = await app.request(`/api/pipelines/T/instances${query}`, { headers: loopback });
    assert.equal(res.status, 200, `GET …/instances${query} is an open read`);
    return ((await res.json()) as { instances: PipelineInstance[] }).instances.map((i) => i.id);
  };

  assert.deepEqual(await ids("?parent=P1"), ["c2", "c1"], "P1's children of T, newest first");
  assert.deepEqual(await ids("?parent=P2"), ["c3"], "each parent its own");
  assert.deepEqual(await ids(""), ["c3", "c2", "c1", "m1"], "no filter: every instance of T");
  assert.deepEqual(await ids("?parent="), ["c3", "c2", "c1", "m1"], "an empty filter is none");
  assert.deepEqual(await ids("?parent=nope"), [], "an unknown parent is an empty list");
});

// ── The edit guard ───────────────────────────────────────────────────────────

test("an execution edit of a pipeline a live parent still spawns is held, unless forced", async () => {
  const app = makeApp();
  const created = await post(app, "/api/pipelines", {
    name: "Task",
    trigger: null,
    overlapPolicy: "allow",
    phases: [phaseDef("build")],
  });
  assert.equal(created.status, 201, "the task pipeline is saved");
  const target = created.body as unknown as PipelineDefinition;
  let version = 0;
  const put = async (over: Record<string, unknown> = {}, query = "") => {
    const res = await app.request(`/api/pipelines/${target.id}${query}`, {
      method: "PUT",
      headers: sameOrigin,
      body: JSON.stringify({
        name: "Task",
        trigger: null,
        overlapPolicy: "allow",
        // A changed prompt each time: an execution edit.
        phases: [phaseDef("build", { steps: [{ name: "s", prompt: `v${++version}` }] })],
        ...over,
      }),
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        error: string;
        code: string;
        instances: { id: string; status: string; pipelineId: string }[];
      },
    };
  };
  const parent = (status: InstanceStatus, tasks: PhaseProgress["status"]) =>
    writeInstance(
      instance({
        id: "parent",
        pipelineId: "delivery",
        status,
        definition: deliveryDef(target.id),
        phases: [
          progress("plan", status === "succeeded" ? "succeeded" : "awaiting-approval", {
            gated: true,
            pause: "gate",
          }),
          progress("tasks", tasks),
          progress("ship", status === "succeeded" ? "succeeded" : "pending"),
        ],
      }),
    );
  const child = (status: InstanceStatus) =>
    writeInstance(
      instance({
        id: "child",
        pipelineId: target.id,
        status,
        trigger: "spawned",
        definition: target,
        parent: {
          instanceId: "parent",
          pipelineId: "delivery",
          phaseId: "tasks",
          index: 0,
          key: "a",
        },
      }),
    );

  // Only the parent is live: its spawn phase will start instances that read
  // the definition as it is then.
  await parent("awaiting-approval", "pending");
  const held = await put();
  assert.equal(held.status, 409, "held while a live parent will spawn more");
  assert.equal(held.body.code, "instances-running", "with the code a client acts on");
  assert.deepEqual(
    held.body.instances,
    [{ id: "parent", status: "awaiting-approval", pipelineId: "delivery" }],
    "naming the parent, under its own pipeline",
  );
  assert.match(held.body.error, /1 live instance of another pipeline will start more instances/);
  assert.match(held.body.error, /force=1/, "it says how to save it anyway");
  assert.doesNotMatch(held.body.error, /running under/, "no own instance is claimed");

  // A live child too: the pipeline's own instances first, then the parents.
  await child("running");
  const both = await put();
  assert.equal(both.status, 409, "still held");
  assert.deepEqual(
    both.body.instances,
    [
      { id: "child", status: "running", pipelineId: target.id },
      { id: "parent", status: "awaiting-approval", pipelineId: "delivery" },
    ],
    "own instances first, each with its pipeline",
  );
  assert.match(both.body.error, /^1 instance is running under "Task"\. /, "the own sentence");
  assert.match(both.body.error, /will start more instances of "Task"/, "the spawner sentence");

  // A rename changes nothing about work in flight; forced, the edit lands.
  const renamed = await put({ name: "Task (renamed)", phases: target.phases });
  assert.equal(renamed.status, 200, "a rename saves freely");
  const forced = await put({}, "?force=1");
  assert.equal(forced.status, 200, "?force=1 saves it anyway");

  // A parent past its spawn phase starts no more children.
  await child("succeeded");
  await parent("running", "succeeded");
  assert.equal((await put()).status, 200, "a joined spawn phase holds nothing");
  await parent("running", "skipped");
  assert.equal((await put()).status, 200, "nor does a skipped one");
  await parent("running", "failed");
  assert.equal((await put()).status, 409, "a failed one does: a revise re-runs it");
  await parent("succeeded", "pending");
  assert.equal((await put()).status, 200, "an ended parent holds nothing");

  // Without a live parent, the refusal is exactly what it was before spawns.
  await child("running");
  const own = await put();
  assert.equal(own.status, 409, "the pipeline's own live instance holds it");
  assert.equal(
    own.body.error,
    '1 instance is running under "Task". They keep the definition they started with; ' +
      "this edit applies to the next start only. Repeat with ?force=1 to save it anyway.",
    "byte-identical to the refusal without spawners",
  );
  assert.deepEqual(
    own.body.instances,
    [{ id: "child", status: "running", pipelineId: target.id }],
    "only the pipeline's own instance",
  );
});

// ── Refusal codes ────────────────────────────────────────────────────────────

test("approve, revise and abort forward the engine's refusal code as `code`", async () => {
  let reply: ActionResult = { ok: true, code: 200 };
  const app = makeApp({
    ...fakeEngine,
    approve: async () => reply,
    revise: async () => reply,
    abort: async () => reply,
  });

  reply = { ok: false, code: 409, error: "x", errorCode: "parent-decided" };
  const decided = { status: 409, body: { ok: false, error: "x", code: "parent-decided" } };
  assert.deepEqual(await post(app, "/api/instances/i1/approve"), decided, "approve");
  assert.deepEqual(await post(app, "/api/instances/i1/revise", { note: "n" }), decided, "revise");

  reply = { ok: false, code: 400, error: "y", errorCode: "answers-not-accepted" };
  assert.deepEqual(
    await post(app, "/api/instances/i1/approve", { answers: "a" }),
    { status: 400, body: { ok: false, error: "y", code: "answers-not-accepted" } },
    "a 400 keeps its status and code",
  );

  reply = { ok: false, code: 409, error: "z", errorCode: "children-running" };
  assert.deepEqual(
    await post(app, "/api/instances/i1/approve"),
    { status: 409, body: { ok: false, error: "z", code: "children-running" } },
    "children-running",
  );

  // A refusal no client acts on has no `code` key, as before.
  reply = { ok: false, code: 409, error: "instance is not awaiting approval" };
  for (const action of ["approve", "revise", "abort"]) {
    assert.deepEqual(
      await post(app, `/api/instances/i1/${action}`),
      { status: 409, body: { ok: false, error: "instance is not awaiting approval" } },
      `${action}: no code`,
    );
  }
  reply = { ok: true, code: 200 };
  assert.deepEqual(
    await post(app, "/api/instances/i1/approve"),
    { status: 200, body: { ok: true } },
    "success is unchanged",
  );
});

// ── parent-decided, real engine ──────────────────────────────────────────────

test("a child whose parent has joined its task is not approved or revised, but can be aborted", async () => {
  const app = appWithEngine();
  await writeParent(
    "running",
    tasksPhase("succeeded", [{ key: "a", state: "succeeded", instanceId: "child" }]),
  );
  await writeChild("child");

  const approve = await post(app, "/api/instances/child/approve");
  assert.equal(approve.status, 409, "approve is refused");
  assert.equal(approve.body.code, "parent-decided", "with the code a client acts on");
  assert.match(String(approve.body.error), /spawned child/, "and says why");
  const revise = await post(app, "/api/instances/child/revise", { note: "again" });
  assert.equal(revise.status, 409, "revise is refused");
  assert.equal(revise.body.code, "parent-decided", "the same code");
  assert.deepEqual(await gateDecisions(app, "child"), [], "nothing was recorded");
  assert.equal((await readInstance("child"))?.status, "awaiting-approval", "nothing changed");

  const abort = await post(app, "/api/instances/child/abort");
  assert.equal(abort.status, 200, "abort always works");
  assert.equal((await readInstance("child"))?.status, "aborted", "the child is stopped");
});

test("parent-decided holds for an ended parent and a re-run task; a parent gone frees the child", async () => {
  const app = appWithEngine();

  await writeParent(
    "aborted",
    tasksPhase("aborted", [{ key: "a", state: "running", instanceId: "c1" }]),
  );
  await writeChild("c1");
  const ended = await post(app, "/api/instances/c1/approve");
  assert.equal(ended.status, 409, "an aborted parent waits for nothing");
  assert.equal(ended.body.code, "parent-decided", "parent-decided");

  await writeParent(
    "running",
    tasksPhase("running", [{ key: "a", state: "running", instanceId: "c-new" }]),
  );
  await writeChild("c2");
  const replaced = await post(app, "/api/instances/c2/approve");
  assert.equal(replaced.status, 409, "the task now runs in another child");
  assert.equal(replaced.body.code, "parent-decided", "parent-decided");

  await writeChild("c3", "gone");
  const orphan = await post(app, "/api/instances/c3/approve");
  assert.equal(orphan.status, 200, "with its parent's record gone, the child is the operator's");
  assert.equal("code" in orphan.body, false, "no refusal code");
});

// ── The children pause ───────────────────────────────────────────────────────

/** `P` paused at `children`: task `a` failed in `c-a` (failed at `build`), `b` blocked. */
async function pausedAtChildren(): Promise<void> {
  await writeParent(
    "awaiting-approval",
    tasksPhase(
      "awaiting-approval",
      [
        { key: "a", state: "failed", instanceId: "c-a", reason: "phase build failed" },
        { key: "b", dependsOn: [0], state: "blocked" },
      ],
      { pause: "children" },
    ),
  );
  await writeInstance(
    instance({
      id: "c-a",
      pipelineId: "T",
      status: "failed",
      trigger: "spawned",
      parent: { instanceId: "P", pipelineId: "delivery", phaseId: "tasks", index: 0, key: "a" },
      phases: [progress("build", "failed", { name: "Build" })],
    }),
  );
}

test("answers to a spawn phase paused at children are refused with answers-not-accepted", async () => {
  const app = appWithEngine();
  await pausedAtChildren();

  for (const answers of ["x", null]) {
    const res = await post(app, "/api/instances/P/approve", { answers });
    assert.equal(res.status, 400, `answers ${JSON.stringify(answers)} are refused`);
    assert.equal(res.body.code, "answers-not-accepted", "with the code a client acts on");
  }
  assert.deepEqual(await gateDecisions(app, "P"), [], "nothing was recorded");
  const tasks = (await readInstance("P"))?.phases.find((p) => p.id === "tasks");
  assert.equal(tasks?.status, "awaiting-approval", "the spawn phase still waits");
  assert.equal(tasks?.pause, "children", "at its children pause");
});

test("the gate review of a spawn phase carries its children; a running one is not waiting", async () => {
  const app = makeApp();
  await pausedAtChildren();

  const res = await app.request("/api/instances/P/phases/tasks/review", { headers: loopback });
  assert.equal(res.status, 200, "a spawn phase paused at children has a review");
  const review = (await res.json()) as PhaseReview;
  assert.equal(review.canApprove, true, "approve accepts the tasks that succeeded");
  assert.deepEqual(
    review.children?.tasks.map((t) => [t.key, t.child?.decisionPhase ?? null]),
    [
      ["a", { phaseId: "build", phaseName: "Build", attempt: 1, status: "failed" }],
      ["b", null],
    ],
    "the failed child names the phase a person would revise; a blocked task has no child",
  );
  assert.equal(review.children?.tasks[0].child?.status, "failed", "read from the child now");
  assert.deepEqual(review.children?.notSucceeded, ["a", "b"], "what approving drops");

  await writeParent(
    "running",
    tasksPhase("running", [{ key: "a", state: "running", instanceId: "c-a" }]),
  );
  const running = await app.request("/api/instances/P/phases/tasks/review", {
    headers: loopback,
  });
  assert.equal(running.status, 409, "a running spawn phase is not waiting on you");
});
