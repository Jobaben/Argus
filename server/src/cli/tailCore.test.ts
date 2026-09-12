import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Agent, OverviewEntry, PipelineInstance, Run } from "@argus/contracts";
import {
  boardInstances,
  buildSnapshot,
  clip,
  endLine,
  formatMs,
  parseDuration,
  parseFrame,
  parseTailArgs,
  refreshFor,
  renderJson,
  renderText,
  stepLabels,
  Tracker,
} from "./tailCore.js";

const NOW = new Date("2026-07-07T10:30:00.000Z");
const env = {} as NodeJS.ProcessEnv;

function run(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    scheduleId: "sched-1",
    scheduleName: "Nightly triage",
    prompt: "p",
    cwd: "/repo",
    status: "running",
    trigger: "scheduled",
    queuedAt: "2026-07-07T10:20:00.000Z",
    startedAt: "2026-07-07T10:20:00.000Z",
    endedAt: null,
    durationMs: null,
    pid: 1,
    exitCode: null,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
    ...over,
  };
}

function instance(over: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "inst-1",
    pipelineId: "pipe-1",
    pipelineName: "Release train",
    status: "running",
    currentPhaseIndex: 0,
    phases: [
      {
        id: "build",
        name: "build",
        gated: false,
        status: "running",
        attempt: 1,
        payload: null,
        steps: [{ name: "compile", runId: "step-1", status: "running" }],
      },
      {
        id: "review",
        name: "review",
        gated: true,
        status: "pending",
        attempt: 1,
        payload: null,
        steps: [
          { name: "lint", runId: null, status: "pending" },
          { name: "test", runId: null, status: "pending" },
        ],
      },
    ],
    trigger: "manual",
    signalToken: "t",
    createdAt: "2026-07-07T10:00:00.000Z",
    updatedAt: "2026-07-07T10:00:00.000Z",
    endedAt: null,
    ...over,
  };
}

function entry(inst: PipelineInstance | null, active: PipelineInstance[] = []): OverviewEntry {
  return {
    definition: {
      id: "pipe-1",
      name: "Release train",
      phases: [],
      trigger: null,
      enabled: true,
      overlapPolicy: "skip",
      lastStartedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    latest: inst,
    cost: null,
    active: active.map((instance) => ({ instance, cost: { usd: null, tokens: null } })),
  };
}

function agent(over: Partial<Agent> = {}): Agent {
  return {
    short: "a1",
    sessionId: null,
    name: "refactor-auth",
    status: "working",
    tempo: null,
    detail: "editing auth.ts",
    result: null,
    template: null,
    cwd: null,
    cliVersion: null,
    inFlight: null,
    createdAt: null,
    updatedAt: "2026-07-07T10:29:00.000Z",
    firstTerminalAt: null,
    live: true,
    pid: 1,
    ...over,
  };
}

describe("parseDuration", () => {
  it("reads seconds, minutes, hours, bare numbers and zero", () => {
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("5m"), 300_000);
    assert.equal(parseDuration("1h"), 3_600_000);
    assert.equal(parseDuration("250ms"), 250);
    assert.equal(parseDuration("45"), 45_000);
    assert.equal(parseDuration("0"), 0);
    assert.equal(parseDuration("1.5m"), 90_000);
  });
  it("rejects garbage", () => {
    assert.equal(parseDuration("soon"), null);
    assert.equal(parseDuration("-5s"), null);
    assert.equal(parseDuration(""), null);
  });
});

describe("parseTailArgs", () => {
  it("defaults to a bounded window when piped and forever on a terminal", () => {
    const piped = parseTailArgs([], env, false);
    assert.equal(piped.kind, "run");
    if (piped.kind === "run") assert.equal(piped.options.forMs, 60_000);
    const tty = parseTailArgs([], env, true);
    if (tty.kind === "run") assert.equal(tty.options.forMs, null);
  });

  it("takes the port and token from the environment", () => {
    const parsed = parseTailArgs([], { ARGUS_PORT: "8123", ARGUS_TOKEN: " s3cret " }, false);
    assert.equal(parsed.kind, "run");
    if (parsed.kind !== "run") return;
    assert.equal(parsed.options.url, "http://127.0.0.1:8123");
    assert.equal(parsed.options.token, "s3cret");
  });

  it("parses every flag in both spellings", () => {
    const parsed = parseTailArgs(
      [
        "--for=2m",
        "--since",
        "1h",
        "--json",
        "--until-idle",
        "--context=0",
        "--no-snapshot",
        "--url",
        "http://localhost:9999/",
        "--token=abc",
      ],
      env,
      true,
    );
    assert.equal(parsed.kind, "run");
    if (parsed.kind !== "run") return;
    assert.deepEqual(parsed.options, {
      url: "http://localhost:9999",
      token: "abc",
      forMs: 120_000,
      untilIdle: true,
      sinceMs: 3_600_000,
      json: true,
      context: 0,
      snapshot: false,
      installSkill: null,
    });
  });

  it("reads --install-skill bare, with a runtime, or with all — and never eats the next flag", () => {
    const auto = parseTailArgs(["--install-skill"], env, true);
    if (auto.kind === "run") assert.equal(auto.options.installSkill, "auto");
    else assert.fail("expected run");
    const codex = parseTailArgs(["--install-skill=codex"], env, true);
    if (codex.kind === "run") assert.equal(codex.options.installSkill, "codex");
    else assert.fail("expected run");
    const all = parseTailArgs(["--install-skill=ALL", "--json"], env, true);
    if (all.kind === "run") {
      assert.equal(all.options.installSkill, "all");
      assert.equal(all.options.json, true);
    } else assert.fail("expected run");
    const bad = parseTailArgs(["--install-skill=qwen"], env, true);
    assert.equal(bad.kind, "error");
    if (bad.kind === "error") assert.match(bad.message, /takes claude, codex or all, got "qwen"/);
    // A space-separated value is not a value: it surfaces as an unknown option.
    const spaced = parseTailArgs(["--install-skill", "codex"], env, true);
    assert.equal(spaced.kind, "error");
  });

  it("reports bad values and unknown flags, and recognises --help", () => {
    assert.equal(parseTailArgs(["--help"], env, true).kind, "help");
    const bad = parseTailArgs(["--for", "soon"], env, true);
    assert.equal(bad.kind, "error");
    if (bad.kind === "error") assert.match(bad.message, /--for needs a duration/);
    const missing = parseTailArgs(["--url"], env, true);
    assert.equal(missing.kind, "error");
    const scheme = parseTailArgs(["--url", "ftp://x"], env, true);
    assert.equal(scheme.kind, "error");
    const unknown = parseTailArgs(["--verbose"], env, true);
    assert.equal(unknown.kind, "error");
    if (unknown.kind === "error") assert.match(unknown.message, /unknown option "--verbose"/);
  });
});

describe("rendering", () => {
  it("renders text with a local clock and an icon, and JSON without the indent hint", () => {
    const line = {
      at: NOW.toISOString(),
      kind: "run.started" as const,
      text: "Nightly triage started",
      indent: 1,
      runId: "run-1",
    };
    const text = renderText(line);
    assert.match(text, /^\d\d:\d\d:\d\d {3}▶ Nightly triage started$/);
    const json = JSON.parse(renderJson(line)) as Record<string, unknown>;
    assert.equal(json.kind, "run.started");
    assert.equal(json.runId, "run-1");
    assert.equal("indent" in json, false);
  });

  it("formats durations and clips prose to one line", () => {
    assert.equal(formatMs(500), "500ms");
    assert.equal(formatMs(42_000), "42s");
    assert.equal(formatMs(184_000), "3m 04s");
    assert.equal(formatMs(3_900_000), "1h 05m");
    assert.equal(clip("  a\n  b   c "), "a b c");
    assert.equal(clip("x".repeat(200), 10).length, 10);
  });
});

describe("labels", () => {
  it("names a step run by pipeline › phase, adding the step only when a phase has several", () => {
    const inst = instance({
      phases: [
        ...instance().phases.slice(0, 1),
        {
          ...instance().phases[1],
          status: "running",
          steps: [
            { name: "lint", runId: "step-2", status: "running" },
            { name: "test", runId: "step-3", status: "running" },
          ],
        },
      ],
    });
    const labels = stepLabels([inst]);
    assert.equal(labels.get("step-1"), "Release train › build");
    assert.equal(labels.get("step-2"), "Release train › review › lint");
    assert.equal(labels.get("step-3"), "Release train › review › test");
  });

  it("puts every concurrent instance on the board once, falling back to the latest", () => {
    const a = instance({ id: "a" });
    const b = instance({ id: "b" });
    assert.deepEqual(
      boardInstances([entry(a, [a, b])]).map((i) => i.id),
      ["a", "b"],
    );
    assert.deepEqual(
      boardInstances([entry(a)]).map((i) => i.id),
      ["a"],
    );
    assert.deepEqual(boardInstances([entry(null)]), []);
  });
});

describe("buildSnapshot", () => {
  const base = {
    now: NOW,
    url: "http://127.0.0.1:7777",
    version: "0.4.0",
    agents: [] as Agent[],
    situation: null,
    activity: new Map(),
    sinceMs: 30 * 60_000,
    context: 3,
  };

  it("summarises, lists running work with its latest activity, gates, recent outcomes and idleness", () => {
    const step = run({ id: "step-1", scheduleName: "Release train · build", instanceId: "inst-1" });
    const finished = run({
      id: "run-9",
      scheduleName: "Lint sweep",
      status: "succeeded",
      startedAt: "2026-07-07T10:10:00.000Z",
      endedAt: "2026-07-07T10:13:04.000Z",
      durationMs: 184_000,
      costUsd: 0.12,
      resultSummary: "All clean.\nSecond line ignored",
    });
    const failed = run({
      id: "run-8",
      scheduleName: "Deps audit",
      status: "failed",
      endedAt: "2026-07-07T10:25:00.000Z",
      durationMs: 5_000,
      exitCode: 1,
      error: "npm audit found 3 vulnerabilities",
    });
    const old = run({
      id: "run-old",
      status: "succeeded",
      endedAt: "2026-07-07T08:00:00.000Z",
    });
    const gated = instance({
      id: "inst-2",
      pipelineName: "Docs sweep",
      status: "awaiting-approval",
      updatedAt: "2026-07-07T10:18:00.000Z",
      phases: [
        {
          id: "review",
          name: "review",
          gated: true,
          status: "awaiting-approval",
          attempt: 1,
          payload: { summary: "Three files changed, please look at README" },
          steps: [{ name: "draft", runId: "run-7", status: "succeeded" }],
        },
      ],
    });
    const lines = buildSnapshot({
      ...base,
      runs: [step, finished, failed, old],
      overview: [entry(instance(), [instance(), gated])],
      activity: new Map([
        [
          "step-1",
          [
            { at: "2026-07-07T10:20:01.000Z", kind: "init", label: "session started" },
            { at: "2026-07-07T10:21:00.000Z", kind: "tool", label: "Read: app.ts" },
            { at: "2026-07-07T10:22:00.000Z", kind: "tool", label: "Bash: npm test" },
          ],
        ],
      ]),
    });
    const texts = lines.map((l) => `${l.kind}|${l.text}`);
    assert.equal(
      texts[0],
      "snapshot.summary|Argus 0.4.0 at http://127.0.0.1:7777 — 1 running · 1 waiting for approval",
    );
    assert.equal(
      texts[1],
      "snapshot.running|Release train › build · running 10m 00s · ⚙ Bash: npm test",
    );
    // Context lines: the retained activity under its step, oldest first.
    assert.deepEqual(texts.slice(2, 5), [
      "snapshot.activity|○ session started",
      "snapshot.activity|⚙ Read: app.ts",
      "snapshot.activity|⚙ Bash: npm test",
    ]);
    assert.equal(
      texts[5],
      'snapshot.gate|Docs sweep · waiting for approval at "review" for 12m 00s — Three files changed, please look at README',
    );
    // Recent, newest first, inside the window only; failures carry the reason.
    assert.deepEqual(texts.slice(6, 8), [
      "snapshot.recent|✗ Deps audit failed in 5s: npm audit found 3 vulnerabilities",
      "snapshot.recent|✓ Lint sweep succeeded in 3m 04s · $0.12 — All clean.",
    ]);
    assert.equal(
      texts.some((t) => t.includes("run-old")),
      false,
    );
    assert.equal(
      texts.some((t) => t.startsWith("snapshot.idle")),
      false,
    );
  });

  it("says idle when nothing is running, and names the next firing", () => {
    const lines = buildSnapshot({
      ...base,
      runs: [],
      overview: [],
      situation: {
        generatedAt: NOW.toISOString(),
        counts: {
          runsInFlight: 0,
          gatesWaiting: 0,
          failedInstances: 0,
          monitorsDown: 1,
          monitorsFailing: 0,
          openIssues: 2,
          liveAgents: 0,
          anomalies: 0,
        },
        spend: {
          state: "warning",
          today: { spentUsd: 3.5, limitUsd: 4, ratio: 0.875 },
          month: { spentUsd: 30, limitUsd: null, ratio: null },
        },
        nextFire: {
          id: "s",
          name: "Hourly sync",
          kind: "schedule",
          at: "2026-07-07T10:42:00.000Z",
        },
        throughput: [],
      },
    });
    assert.equal(
      lines[0].text,
      "Argus 0.4.0 at http://127.0.0.1:7777 — 0 running · 1 monitor down · 2 open issues · $3.50 today (budget warning)",
    );
    assert.match(lines[1].text, /^next: schedule "Hourly sync" in 12m 00s \(\d\d:\d\d\)$/);
    assert.equal(lines[2].kind, "snapshot.idle");
    assert.match(lines[2].text, /nothing finished in the last 30m 00s/);
  });

  it("lists live background agents and hides context when asked", () => {
    const lines = buildSnapshot({
      ...base,
      context: 0,
      runs: [run()],
      overview: [],
      agents: [agent(), agent({ short: "a2", name: "old", status: "done", live: false })],
      activity: new Map([["run-1", [{ at: NOW.toISOString(), kind: "tool", label: "Grep" }]]]),
    });
    assert.deepEqual(
      lines.map((l) => l.kind),
      ["snapshot.summary", "snapshot.running", "snapshot.agent"],
    );
    assert.equal(lines[2].text, "agent refactor-auth · working · editing auth.ts");
  });
});

describe("Tracker", () => {
  it("primes silently, then narrates run starts and endings", () => {
    const t = new Tracker(() => NOW);
    assert.deepEqual(t.applyRuns([run()]), []);
    assert.equal(t.isIdle(), false);
    const lines = t.applyRuns([
      run({ status: "succeeded", endedAt: "2026-07-07T10:29:00.000Z", durationMs: 540_000 }),
      run({ id: "run-2", scheduleName: "Deps audit", trigger: "manual", model: "haiku" }),
      run({
        id: "run-3",
        scheduleName: "Blink",
        status: "failed",
        endedAt: "2026-07-07T10:29:30.000Z",
        error: "boom",
      }),
    ]);
    assert.deepEqual(
      lines.map((l) => [l.kind, l.text]),
      [
        ["run.ended", "✓ Nightly triage succeeded in 9m 00s"],
        ["run.started", "Deps audit started (manual) · haiku"],
        ["run.ended", "✗ Blink failed: boom"],
      ],
    );
    assert.equal(t.runningCount(), 1);
    // A second read with nothing changed says nothing.
    assert.deepEqual(t.applyRuns([run({ id: "run-2", scheduleName: "Deps audit" })]), []);
  });

  it("uses the board label for a step run and marks a non-default runtime", () => {
    const t = new Tracker(() => NOW);
    t.applyOverview([entry(instance())]);
    t.applyRuns([]);
    const [line] = t.applyRuns([
      run({ id: "step-1", scheduleName: "Release train · build", runtime: "codex", costUsd: 0.5 }),
    ]);
    assert.equal(line.text, "Release train › build (codex) started");
    const [ended] = t.applyRuns([
      run({
        id: "step-1",
        scheduleName: "Release train · build",
        runtime: "codex",
        status: "succeeded",
        durationMs: 61_000,
        costUsd: 0.5,
        tokens: 12_345,
      }),
    ]);
    assert.equal(
      ended.text,
      "✓ Release train › build (codex) succeeded in 1m 01s · ~$0.50 · 12,345 tok",
    );
  });

  it("narrates phase transitions, gates, resumes and endings of a pipeline", () => {
    const t = new Tracker(() => NOW);
    t.applyOverview([entry(instance())]);
    const gated = instance({
      status: "awaiting-approval",
      currentPhaseIndex: 1,
      updatedAt: "2026-07-07T10:31:00.000Z",
      phases: [
        { ...instance().phases[0], status: "succeeded" },
        {
          ...instance().phases[1],
          status: "awaiting-approval",
          payload: { summary: "ready for eyes" },
        },
      ],
    });
    assert.deepEqual(
      t.applyOverview([entry(gated)]).map((l) => [l.kind, l.text]),
      [
        ["phase.changed", "Release train › build succeeded"],
        [
          "pipeline.gate",
          'pipeline Release train is waiting for approval at "review" — ready for eyes',
        ],
      ],
    );
    assert.equal(t.isIdle(), true);
    const resumed = instance({
      status: "running",
      currentPhaseIndex: 1,
      updatedAt: "2026-07-07T10:32:00.000Z",
      phases: [
        { ...instance().phases[0], status: "succeeded" },
        { ...instance().phases[1], status: "running", attempt: 2 },
      ],
    });
    assert.deepEqual(
      t.applyOverview([entry(resumed)]).map((l) => [l.kind, l.text]),
      [
        ["phase.changed", "Release train › review started (attempt 2)"],
        ["pipeline.resumed", "pipeline Release train resumed"],
      ],
    );
    const failed = instance({
      status: "failed",
      endedAt: "2026-07-07T10:33:00.000Z",
      updatedAt: "2026-07-07T10:33:00.000Z",
      phases: [
        { ...instance().phases[0], status: "succeeded" },
        {
          ...instance().phases[1],
          status: "failed",
          attempt: 2,
          payload: { reason: "tests failed", failureClass: "exit-code" },
        },
      ],
    });
    assert.deepEqual(
      t.applyOverview([entry(failed)]).map((l) => [l.kind, l.text]),
      [
        ["phase.changed", "Release train › review failed: tests failed"],
        ["pipeline.ended", '✗ pipeline Release train failed at "review": tests failed'],
      ],
    );
    // A brand-new running instance is a start.
    const fresh = instance({ id: "inst-9", createdAt: "2026-07-07T10:34:00.000Z" });
    assert.deepEqual(
      t.applyOverview([entry(fresh, [fresh, failed])]).map((l) => [l.kind, l.text]),
      [["pipeline.started", "pipeline Release train started (manual)"]],
    );
  });

  it("narrates background agent transitions and ignores already-finished newcomers", () => {
    const t = new Tracker(() => NOW);
    t.applyAgents([agent()]);
    const lines = t.applyAgents([
      agent({ status: "done", result: "Refactored 4 files" }),
      agent({ short: "a2", name: "stale", status: "failed" }),
      agent({ short: "a3", name: "new-job", status: "working", detail: "reading" }),
    ]);
    assert.deepEqual(
      lines.map((l) => l.text),
      [
        "✓ agent refactor-auth working → done · Refactored 4 files",
        "agent new-job working · reading",
      ],
    );
  });

  it("formats payload frames straight off the wire", () => {
    const t = new Tracker(() => NOW);
    t.applyOverview([entry(instance())]);
    const activity = t.applyFrame({
      type: "run:activity",
      runId: "step-1",
      instanceId: "inst-1",
      events: [
        { at: NOW.toISOString(), kind: "tool", label: "Bash: npm test" },
        { at: NOW.toISOString(), kind: "text", label: "Tests pass." },
      ],
    });
    assert.deepEqual(
      activity.map((l) => l.text),
      ["⚙ Release train › build · Bash: npm test", "💬 Release train › build · Tests pass."],
    );
    assert.equal(
      t.applyFrame({
        type: "monitors:alert",
        alert: {
          event: "monitor.down",
          scheduleId: "s",
          name: "Hourly sync",
          status: "down",
          at: NOW.toISOString(),
          detail: "no run since 09:00",
        },
      })[0].text,
      'monitor "Hourly sync" is down — no run since 09:00',
    );
    assert.equal(
      t.applyFrame({
        type: "budget:alert",
        alert: {
          event: "budget.exceeded",
          state: "exceeded",
          at: NOW.toISOString(),
          detail: "$4.10 of $4",
        },
      })[0].text,
      "budget exceeded — $4.10 of $4",
    );
    assert.equal(
      t.applyFrame({
        type: "sentinel:alert",
        alert: {
          event: "incident.opened",
          incidentId: "i",
          key: "k",
          title: "Nightly triage failing",
          detail: "3 in a row",
          severity: "critical",
          at: NOW.toISOString(),
          suppressed: false,
        },
      })[0].text,
      "incident opened (critical): Nightly triage failing — 3 in a row",
    );
    assert.deepEqual(t.applyFrame({ type: "sessions:changed" }), []);
  });
});

describe("frames and refresh policy", () => {
  it("accepts change pings and well-formed payload frames, drops the rest", () => {
    assert.equal(parseFrame('{"type":"pipelines:changed"}')?.type, "pipelines:changed");
    assert.equal(parseFrame('{"type":"hello"}'), null);
    assert.equal(parseFrame("nope"), null);
    assert.equal(parseFrame('{"type":"run:activity","runId":"r","events":[{"at":1}]}'), null);
    assert.equal(
      parseFrame(
        '{"type":"run:activity","runId":"r","events":[{"at":"t","kind":"tool","label":"x"}]}',
      )?.type,
      "run:activity",
    );
    assert.equal(parseFrame('{"type":"monitors:alert","alert":{}}'), null);
  });

  it("maps each ping to the reads it should trigger", () => {
    assert.deepEqual(refreshFor("pipelines:changed"), {
      runs: true,
      overview: true,
      agents: false,
    });
    assert.deepEqual(refreshFor("schedules:changed"), {
      runs: true,
      overview: true,
      agents: false,
    });
    assert.deepEqual(refreshFor("agents:changed"), { runs: false, overview: false, agents: true });
    assert.deepEqual(refreshFor("sessions:changed"), {
      runs: false,
      overview: false,
      agents: false,
    });
  });

  it("closes with why it stopped and what is left", () => {
    const line = endLine({
      now: NOW,
      reason: "window",
      elapsedMs: 60_000,
      events: 4,
      running: 2,
      json: false,
    });
    assert.equal(
      line.text,
      "followed for 1m 00s · 4 events · 2 still running · run `argus tail` again to keep following",
    );
    const idle = endLine({
      now: NOW,
      reason: "idle",
      elapsedMs: 12_000,
      events: 1,
      running: 0,
      json: true,
    });
    assert.equal(idle.text, "idle after 12s · 1 event · nothing running");
  });
});
