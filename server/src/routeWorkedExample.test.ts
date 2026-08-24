import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { createEngine } from "./pipelineEngine.js";
import { createUserStore } from "./userStore.js";
import { readInstance } from "./sources/instances.js";
import { readJournal } from "./sources/journal.js";
import { readResultFile } from "../../hooks/argus-signal.mjs";
import type { ArgusConfig } from "./config.js";
import type { AuthService } from "./auth.js";
import type { PipelineInstance } from "./sources/pipelineTypes.js";
import type { OverviewEntry } from "@argus/contracts";

/**
 * The spec's worked example, end to end, through the real seams.
 *
 * Every layer the feature touches is the real one: the definition is POSTed and
 * validated by the HTTP route, the engine spawns the phases, the "agent" writes
 * its decision to the file the engine named, the *actual* stop-hook reader
 * parses it, the signal arrives over HTTP, and settle() routes on it. Only the
 * child process is a stub — there is no agent to run.
 *
 * Two runs, one per branch, and the assertion that matters most is the second
 * one: a graph where half the work never ran still succeeds, because not running
 * it was the decision rather than a failure.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-worked-"));
  process.env.ARGUS_CLAUDE_HOME = home;
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

const openAuth: AuthService = {
  isConfigured: async () => true,
  status: async () => ({ configured: true, username: "test", role: "root" }),
  login: async () => ({ ok: false, reason: "bad-credentials" }),
  verify: () => ({ username: "test", role: "root" }),
  logout: () => {},
  revokeSessions: () => {},
};

const sameOrigin = {
  host: "localhost:7777",
  origin: "http://localhost:7777",
  "content-type": "application/json",
};

const accepted = (value: boolean) => ({
  predicate: { path: ["accepted"], operator: "equals", value },
});

/** evaluate → publish | repair → report (joining on whichever ran). */
const workedExample = () => ({
  name: "Release train",
  trigger: null,
  phases: [
    {
      id: "evaluate",
      name: "Evaluate",
      cwd: home,
      gated: false,
      steps: [{ name: "decide", prompt: "Judge the release candidate." }],
      result: {
        artifact: "evaluation",
        schema: {
          type: "object",
          required: ["accepted"],
          properties: { accepted: { type: "boolean" } },
        },
      },
    },
    {
      id: "publish",
      name: "Publish",
      cwd: home,
      gated: false,
      steps: [{ name: "ship", prompt: "Ship it: {{artifacts.evaluation}}" }],
      needs: [{ phase: "evaluate", when: accepted(true) }],
    },
    {
      id: "repair",
      name: "Repair",
      cwd: home,
      gated: false,
      steps: [{ name: "fix", prompt: "Fix what the evaluation rejected." }],
      needs: [{ phase: "evaluate", when: accepted(false) }],
    },
    {
      id: "report",
      name: "Report",
      cwd: home,
      gated: false,
      steps: [{ name: "write", prompt: "Write up whatever happened." }],
      needs: [
        { phase: "publish", allowSkipped: true },
        { phase: "repair", allowSkipped: true },
      ],
    },
  ],
});

interface Spawned {
  runId: string;
  phaseId: string;
  env: Record<string, string>;
}

/**
 * One end-to-end run of the example.
 *
 * `decision` is what the agent writes to its result file. Each spawned step is
 * completed the way a real one is: the hook reads the result file the engine
 * named and POSTs the signal.
 */
async function runExample(decision: { accepted: boolean }): Promise<{
  instance: PipelineInstance;
  spawned: Spawned[];
  prompts: Map<string, string>;
  overview: () => Promise<OverviewEntry[]>;
}> {
  const spawned: Spawned[] = [];
  const prompts = new Map<string, string>();
  let counter = 0;

  const engine = createEngine({
    now: () => new Date(2026, 7, 13, 12, 0),
    newId: () => `id-${++counter}`,
    signalUrlBase: "http://localhost:7777",
    maxConcurrent: 4,
    tickMs: 30000,
    spawn: (run, _log, env) => {
      prompts.set(run.phaseId ?? "", run.prompt);
      spawned.push({ runId: run.id, phaseId: run.phaseId ?? "", env });
      // The agent's half of the contract: a phase that was told where to write
      // its decision writes it there, and says nothing about it in prose.
      if (env.ARGUS_RESULT_FILE) writeFileSync(env.ARGUS_RESULT_FILE, JSON.stringify(decision));
      return { pid: 1000 + spawned.length, done: new Promise<{ code: number | null }>(() => {}) };
    },
  });

  const app = createApp({
    config,
    engine,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth: openAuth,
  });

  const created = await app.request("/api/pipelines", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify(workedExample()),
  });
  assert.equal(created.status, 201, "the routed definition is accepted");
  const { id } = (await created.json()) as { id: string };

  const started = await app.request(`/api/pipelines/${id}/start`, {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(started.status, 202);
  const instanceId = ((await started.json()) as { id: string }).id;
  const token = (await readInstance(instanceId))!.signalToken;

  // Complete each spawned step as its stop hook would, waiting for the engine's
  // detached launch of whatever the decision authorized. The instance's own
  // status is the stop condition: once it is terminal there is nothing left to
  // spawn, so nothing left to sign for.
  for (let done = 0; ; done++) {
    if (spawned.length <= done) {
      const current = await readInstance(instanceId);
      if (!current || current.status !== "running") break;
      if (!(await settling(spawned, done))) break;
    }
    const step = spawned[done];
    const result = readResultFile(step.env.ARGUS_RESULT_FILE);
    const res = await app.request(`/api/instances/${instanceId}/signal`, {
      method: "POST",
      headers: sameOrigin,
      body: JSON.stringify({
        phaseId: step.phaseId,
        runId: step.runId,
        type: "completed",
        token,
        payload: { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" },
        ...result,
      }),
    });
    assert.equal(res.status, 202, `signal for ${step.phaseId}`);
  }

  return {
    instance: (await readInstance(instanceId))!,
    spawned,
    prompts,
    // The board reads the instance through here, so this is where a dropped
    // field would actually be noticed.
    overview: async () =>
      (
        (await (await app.request("/api/overview", { headers: sameOrigin })).json()) as {
          overview: OverviewEntry[];
        }
      ).overview,
  };
}

/** Give the engine's detached launch a moment to add the next wave, if any. */
async function settling(spawned: Spawned[], done: number): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (spawned.length <= done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return spawned.length > done;
}

test("accepted: the publish branch runs, repair is skipped, and the join reports", async () => {
  const { instance, spawned, prompts, overview } = await runExample({ accepted: true });

  assert.deepEqual(
    spawned.map((s) => s.phaseId),
    ["evaluate", "publish", "report"],
    "only the selected branch was ever spawned",
  );
  assert.deepEqual(
    instance.phases.map((p) => [p.id, p.status]),
    [
      ["evaluate", "succeeded"],
      ["publish", "succeeded"],
      ["repair", "skipped"],
      ["report", "succeeded"],
    ],
  );
  assert.equal(instance.status, "succeeded");

  // The decision was recorded once, with its grounds, and published as an
  // artifact the selected branch's prompt could read.
  assert.equal(instance.routeDecisions?.length, 1);
  assert.deepEqual(instance.routeDecisions![0].selected, ["publish"]);
  assert.deepEqual(instance.routeDecisions![0].skipped, ["repair"]);
  assert.deepEqual(instance.artifacts?.evaluation, { accepted: true });
  assert.equal(prompts.get("publish"), 'Ship it: {"accepted":true}');

  // And the deciding step was told where to write, in prose that carries the
  // schema rather than the mechanic.
  assert.match(prompts.get("evaluate")!, /ARGUS_RESULT_FILE/);
  assert.match(prompts.get("evaluate")!, /"accepted"/);

  // And all of it reaches the board: the overview enriches the instance with
  // run costs, and must not lose the routing state doing it.
  const [entry] = await overview();
  assert.equal(entry.latest?.routeDecisions?.length, 1);
  assert.deepEqual(entry.latest?.phases[0].result, { accepted: true });
  assert.equal(entry.latest?.phases[2].status, "skipped");
  assert.equal(entry.definition.phases[0].result?.artifact, "evaluation");

  const journal = await readJournal(instance.id);
  assert.equal(
    journal.find((e) => e.kind === "route.selection")?.phaseId,
    "evaluate",
    "the journal explains the branch",
  );
  assert.equal(journal.find((e) => e.kind === "route.skip")?.phaseId, "repair");
});

test("rejected: the repair branch runs instead, and the instance still succeeds", async () => {
  const { instance, spawned } = await runExample({ accepted: false });

  assert.deepEqual(
    spawned.map((s) => s.phaseId),
    ["evaluate", "repair", "report"],
  );
  assert.deepEqual(
    instance.phases.map((p) => [p.id, p.status]),
    [
      ["evaluate", "succeeded"],
      ["publish", "skipped"],
      ["repair", "succeeded"],
      ["report", "succeeded"],
    ],
  );
  // The whole point: a graph with a branch that never ran is not a failure and
  // not a half-finished run. It did what it was asked to do.
  assert.equal(instance.status, "succeeded");
  assert.ok(instance.endedAt, "and it is terminal");
  assert.deepEqual(instance.routeDecisions![0].selected, ["repair"]);
});
