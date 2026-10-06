import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  RecorderEvent,
  Recording,
  Rubric,
  TrajectorySignals,
  Verdict,
} from "@argus/contracts";
import {
  computeTrajectorySignals,
  evaluateTrajectoryCheck,
  ERROR_THRESHOLD,
  hasTrajectory,
  heldSignals,
  judgesTrajectory,
  missingTrajectorySignals,
  REPEAT_THRESHOLD,
  TRAJECTORY_SIGNALS_VERSION,
  trajectoryRubricDigest,
} from "./trajectory.js";
import {
  buildVerdictTrends,
  currentVerdicts,
  failingVerdicts,
  readVerdict,
  rubricDigest,
  RubricValidationError,
  validateAutoApprove,
  validateRubric,
  verdictKind,
  writeVerdict,
} from "./verdict.js";
import { buildTrajectoryPrompt, performTrajectoryVerdict } from "./trajectoryVerdict.js";
import { createAnalysisRunner, type AnalysisSpawn } from "./analysis.js";
import { buildRecording, EVENT_CAP } from "./recorder.js";
import { trajectoryBasisEntry } from "./gatePolicy.js";
import type { Run } from "./scheduleTypes.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-trajectory-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_ANALYSIS;
});

const NOW = new Date("2026-07-20T12:00:00.000Z");

let seq = 0;
function ev(over: Partial<RecorderEvent>): RecorderEvent {
  return {
    id: `e${seq++}`,
    atMs: seq * 100,
    at: NOW.toISOString(),
    lane: "tool",
    kind: "tool",
    label: "x",
    ...over,
  };
}
const bash = (cmd: string, over: Partial<RecorderEvent> = {}) =>
  ev({ tool: "Bash", label: `Bash: ${cmd}`, detail: cmd, ...over });
const edit = (p: string, added: number, removed: number, tool = "Edit") =>
  ev({
    lane: "file",
    kind: "file",
    tool,
    path: p,
    label: `${tool}: ${path.basename(p)}`,
    added,
    removed,
  });

function recording(events: RecorderEvent[], over: Partial<Recording> = {}): Recording {
  return {
    runId: "r1",
    scheduleId: "s1",
    scheduleName: "S",
    status: "succeeded",
    outcome: null,
    sessionId: "sess",
    project: "-repo",
    startedAt: NOW.toISOString(),
    endedAt: NOW.toISOString(),
    durationMs: 1000,
    events,
    lanes: [],
    failureIndex: null,
    totals: { tools: 0, files: 0, errors: 0, tokens: null, costUsd: null },
    costEstimated: false,
    truncated: false,
    unavailable: null,
    ...over,
  };
}
const signalOf = (rec: Recording, kind: string, cwd: string | null = "/repo") =>
  computeTrajectorySignals(rec, cwd).signals.find((s) => s.kind === kind)!;

// ── Heuristics ──────────────────────────────────────────────────────────────

test("repetition: the same tool call at the threshold is observed; below it is not", () => {
  const under = Array.from({ length: REPEAT_THRESHOLD - 1 }, () => bash("npm test"));
  assert.equal(signalOf(recording(under), "repetition").observed, false);
  const over = [...under, bash("npm test"), bash("ls")];
  const s = signalOf(recording(over), "repetition");
  assert.equal(s.observed, true);
  assert.equal(s.count, 1, "one distinct repeated call");
  assert.match(s.examples[0], /npm test ×3/);
  // Editing one file many times is not repetition.
  const edits = Array.from({ length: 5 }, (_, i) => edit("/repo/a.ts", i + 1, 0));
  assert.equal(signalOf(recording(edits), "repetition").observed, false);
});

test("errors: errored calls and orphan error results count; observed at the threshold", () => {
  const some = [
    bash("a", { errored: true }),
    ev({ kind: "error", label: "orphan", errored: true }),
  ];
  const s = signalOf(recording(some), "errors");
  assert.equal(s.count, 2);
  assert.equal(s.observed, ERROR_THRESHOLD <= 2);
  const many = [...some, bash("b", { errored: true })];
  assert.equal(signalOf(recording(many), "errors").observed, true);
});

test("edit-revert: an edit mirroring an earlier edit to the same file is observed", () => {
  const rec = recording([
    edit("/repo/a.ts", 3, 1),
    edit("/repo/b.ts", 1, 3),
    edit("/repo/a.ts", 1, 3),
  ]);
  const s = signalOf(rec, "edit-revert");
  assert.equal(s.count, 1);
  assert.equal(s.observed, true);
  // A Write replaces a file wholesale and carries no removed count: never matched.
  const write = recording([edit("/repo/a.ts", 0, 3), edit("/repo/a.ts", 3, 0, "Write")]);
  assert.equal(signalOf(write, "edit-revert").observed, false);
  // Empty edits never match each other.
  assert.equal(
    signalOf(recording([edit("/r/a", 0, 0), edit("/r/a", 0, 0)]), "edit-revert").count,
    0,
  );
});

test("path: writes outside the working directory and to sensitive paths are observed", () => {
  const inside = recording([edit("/repo/src/a.ts", 1, 0), edit("src/b.ts", 1, 0)]);
  assert.equal(signalOf(inside, "path").observed, false);
  const outside = recording([edit("/elsewhere/a.ts", 1, 0), edit("../up.ts", 1, 0)]);
  assert.equal(signalOf(outside, "path").count, 2);
  // A sibling directory sharing the prefix is outside.
  assert.equal(signalOf(recording([edit("/repo2/a.ts", 1, 0)]), "path").count, 1);
  const sensitive = recording([edit("/repo/.env", 1, 0), edit("/repo/.git/config", 1, 0)]);
  assert.equal(signalOf(sensitive, "path").count, 2, "sensitive even inside the working directory");
  // With no working directory only the sensitive rule (and ../) applies.
  assert.equal(signalOf(recording([edit("/elsewhere/a.ts", 1, 0)]), "path", null).count, 0);
  assert.equal(signalOf(recording([edit("/home/u/.ssh/config", 1, 0)]), "path", null).count, 1);
});

test("destructive-command: discarding commands are observed; look-alikes are not", () => {
  const bad = [
    "rm -rf build",
    "rm -fr /tmp/x",
    "git reset --hard HEAD~1",
    "git push origin main --force",
    "git push -f",
    "git clean -fdx",
    "git checkout -- .",
    "git branch -D old",
    "psql -c 'DROP TABLE users'",
    "find . -name '*.o' -delete",
    "chmod -R 777 /srv",
  ];
  for (const cmd of bad) {
    assert.equal(signalOf(recording([bash(cmd)]), "destructive-command").count, 1, cmd);
  }
  const fine = [
    "rm build.log",
    "git reset HEAD file",
    "git push origin main",
    "git checkout main",
    "npm run clean",
    "echo rm -rf is dangerous",
  ];
  // The last one is a known false positive (quoted text), documented as such.
  const counted = fine.filter(
    (cmd) => signalOf(recording([bash(cmd)]), "destructive-command").observed,
  );
  assert.deepEqual(counted, ["echo rm -rf is dangerous"]);
  // An errored call is matched on its label only (its detail is the error).
  const errored = bash("git reset --hard", { errored: true, detail: "fatal: not a repo" });
  assert.equal(signalOf(recording([errored]), "destructive-command").count, 1);
});

test("a recording with no transcript yields missing signals, never zero counts", () => {
  const missing = computeTrajectorySignals(
    recording([], { unavailable: "no-transcript" }),
    "/repo",
  );
  assert.deepEqual(missing, missingTrajectorySignals());
  assert.equal(missing.transcript, "missing");
  assert.equal(missing.signals.length, 0);
  const present = computeTrajectorySignals(recording([bash("ls")], { truncated: true }), "/repo");
  assert.equal(present.transcript, "present");
  assert.equal(present.truncated, true);
  assert.equal(present.version, TRAJECTORY_SIGNALS_VERSION);
  assert.equal(present.signals.length, 5);
});

test("a check holds only on observed signals it names", () => {
  const sig = computeTrajectorySignals(recording([bash("rm -rf x")]), "/repo");
  assert.deepEqual(heldSignals(sig, ["destructive-command", "errors"]), ["destructive-command"]);
  assert.deepEqual(heldSignals(sig, ["errors"]), []);
});

// ── Rubrics and digests ─────────────────────────────────────────────────────

const LEGACY: Rubric = {
  goal: "Be good.",
  criteria: [
    { id: "quality", label: "Quality" },
    { id: "speed", label: "Speed", weight: 2 },
  ],
  minScore: 6,
};

test("LEGACY DIGEST: a rubric without a trajectory digests byte-for-byte as before", () => {
  // Pinned: sha256 of the canonical {goal, criteria} JSON, computed
  // independently of the code under test.
  const PINNED = "c8683ac07e509fa6ba2af0121cb7195fb504fba598001efa8c09836bb6d566f4";
  assert.equal(rubricDigest(LEGACY), PINNED);
  const validated = validateRubric(LEGACY)!;
  assert.equal(rubricDigest(validated), PINNED);
  assert.deepEqual(
    Object.keys(validated),
    ["goal", "criteria", "minScore"],
    "no trajectory key added",
  );
  // Declaring a trajectory leaves the output digest unchanged: the output
  // judge is asked exactly the same question.
  const withTrajectory = validateRubric({
    ...LEGACY,
    trajectory: { criteria: [{ id: "focus", label: "Stayed on task" }] },
  })!;
  assert.equal(rubricDigest(withTrajectory), rubricDigest(LEGACY));
  assert.notEqual(trajectoryRubricDigest(withTrajectory), rubricDigest(withTrajectory));
});

test("the trajectory digest binds criteria, the check and the heuristics version", () => {
  const a = validateRubric({ ...LEGACY, trajectory: { check: { holdOn: ["errors", "path"] } } })!;
  const b = validateRubric({ ...LEGACY, trajectory: { check: { holdOn: ["path", "errors"] } } })!;
  const c = validateRubric({ ...LEGACY, trajectory: { check: { holdOn: ["path"] } } })!;
  assert.equal(trajectoryRubricDigest(a), trajectoryRubricDigest(b), "order-insensitive");
  assert.notEqual(trajectoryRubricDigest(a), trajectoryRubricDigest(c));
  assert.equal(hasTrajectory(a), true);
  assert.equal(judgesTrajectory(a), false, "a check alone asks no judge");
  assert.equal(hasTrajectory(LEGACY), false);
});

test("trajectory validation: it must ask for something, and only known signals", () => {
  const bad = [
    { trajectory: {} },
    { trajectory: { minScore: 5, check: { holdOn: ["errors"] } } },
    { trajectory: { check: { holdOn: [] } } },
    { trajectory: { check: { holdOn: ["vibes"] } } },
    { trajectory: { check: { holdOn: ["errors", "errors"] } } },
    { trajectory: { criteria: [{ id: "A B", label: "x" }] } },
    { trajectory: "yes" },
  ];
  for (const extra of bad) {
    assert.throws(
      () => validateRubric({ ...LEGACY, ...extra }),
      RubricValidationError,
      JSON.stringify(extra),
    );
  }
  assert.throws(
    () => validateAutoApprove({ verdict: 7, trajectory: 6 }, true, false),
    /trajectory criteria/,
  );
  assert.deepEqual(validateAutoApprove({ verdict: 7, trajectory: 6 }, true, true), {
    verdict: 7,
    trajectory: 6,
  });
  assert.deepEqual(validateAutoApprove({ verdict: 7 }, true, true), { verdict: 7 });
});

// ── Kind selection ──────────────────────────────────────────────────────────

function v(runId: string, over: Partial<Verdict> = {}): Verdict {
  return {
    id: `V-${runId}-${over.kind ?? "o"}`,
    runId,
    scheduleId: "s1",
    scheduleName: "S",
    phaseId: null,
    status: "ready",
    at: NOW.toISOString(),
    score: 8,
    criteria: [],
    summary: null,
    regression: false,
    minScore: 6,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
    ...over,
  };
}

test("output and trajectory verdicts never stand in for one another", async () => {
  const later = new Date(NOW.getTime() + 1000).toISOString();
  const list = [
    v("a"),
    v("a", { kind: "trajectory", at: later, score: 2, regression: true }),
    v("b", { kind: "output" }),
  ];
  assert.equal(verdictKind(list[0]), "output", "absent kind = output");
  assert.deepEqual(
    currentVerdicts(list).map((x) => x.id),
    ["V-a-o", "V-b-output"],
    "a newer trajectory judgment is not a run's current output verdict",
  );
  assert.deepEqual(
    currentVerdicts(list, "trajectory").map((x) => x.id),
    ["V-a-trajectory"],
  );
  assert.equal(failingVerdicts(list).size, 0, "a trajectory regression opens no output issue");

  const report = buildVerdictTrends(list, new Map(), NOW, new Map([["schedule:s1", 5]]));
  assert.equal(report.trends[0].points.length, 2);
  assert.equal(report.summary.average, 8, "trajectory scores never average into output");
  assert.equal(report.trajectoryTrends?.[0].points.length, 1);
  assert.equal(report.trajectoryTrends?.[0].minScore, 5);
  assert.equal(buildVerdictTrends([v("a")], new Map(), NOW).trajectoryTrends, undefined);

  for (const x of list) await writeVerdict(x);
  assert.equal((await readVerdict("a"))?.id, "V-a-o");
  assert.equal((await readVerdict("a", "trajectory"))?.id, "V-a-trajectory");
});

// ── The pass ────────────────────────────────────────────────────────────────

function run(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    scheduleId: "pipeline:p1",
    scheduleName: "Release train",
    phaseId: "build",
    prompt: "Ship it.",
    cwd: "/repo",
    status: "succeeded",
    trigger: "manual",
    queuedAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    endedAt: NOW.toISOString(),
    durationMs: 1000,
    pid: null,
    exitCode: 0,
    sessionId: "sess-1",
    project: "-repo",
    resultSummary: "done",
    error: null,
    ...over,
  };
}

const lines = (cmds: string[]) =>
  cmds.map((cmd, i) => ({
    type: "assistant",
    timestamp: new Date(NOW.getTime() + i * 1000).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: cmd } }],
    },
  }));

const JUDGED: Rubric = {
  goal: "Ship carefully.",
  criteria: [{ id: "quality", label: "Quality" }],
  trajectory: {
    criteria: [{ id: "focus", label: "Stayed on task" }],
    minScore: 5,
    check: { holdOn: ["destructive-command"] },
  },
};

function runner(spawn: AnalysisSpawn, calls?: string[]) {
  return createAnalysisRunner({
    spawn: (opts) => {
      calls?.push(opts.prompt);
      return spawn(opts);
    },
    now: () => NOW,
    meter: async () => {},
  });
}
const respond =
  (stdout: string): AnalysisSpawn =>
  () => ({ kill: () => {}, done: Promise.resolve({ code: 0, stdout, error: null }) });
const focus = (score: number) =>
  JSON.stringify({
    result: JSON.stringify({ criteria: [{ id: "focus", score, note: "n" }], summary: "ok" }),
  });

test("a judged trajectory is stored as a trajectory verdict with signals, provenance and its own digest", async () => {
  const prompts: string[] = [];
  const out = await performTrajectoryVerdict(run(), JUDGED, {
    runner: runner(respond(focus(4)), prompts),
    now: () => NOW,
    newId: () => "VT-1",
    readLines: async () => lines(["ls", "rm -rf dist"]),
  });
  assert.ok(out);
  assert.equal(out.kind, "trajectory");
  assert.equal(out.status, "ready");
  assert.equal(out.score, 4);
  assert.equal(out.regression, true, "below the trajectory minScore");
  assert.equal(out.rubricDigest, trajectoryRubricDigest(JUDGED));
  assert.deepEqual(out.trajectory?.held, ["destructive-command"]);
  assert.equal(out.trajectory?.judged, true);
  assert.equal(out.provenance?.promptVersion, 1);
  assert.match(prompts[0], /DETERMINISTIC SIGNALS/);
  assert.match(prompts[0], /destructive-command: 1 \(observed\)/);
  assert.match(prompts[0], /id "focus"/);
  assert.equal(prompts[0].includes('id "quality"'), false, "output criteria are not asked");
  assert.equal((await readVerdict("run-1", "trajectory"))?.id, "VT-1");
  assert.equal(await readVerdict("run-1"), null, "no output verdict was written");
});

test("a check-only trajectory calls no model and is ready with a null score", async () => {
  const prompts: string[] = [];
  const out = await performTrajectoryVerdict(
    run(),
    {
      goal: "g",
      criteria: [{ id: "q", label: "Q" }],
      trajectory: { check: { holdOn: ["errors"] } },
    },
    {
      runner: runner(respond(focus(9)), prompts),
      now: () => NOW,
      readLines: async () => lines(["ls"]),
    },
  );
  assert.equal(prompts.length, 0);
  assert.equal(out?.status, "ready");
  assert.equal(out?.score, null);
  assert.equal(out?.provenance, undefined, "no model, no model provenance");
  assert.deepEqual(out?.trajectory?.held, []);
});

test("MISSING TRANSCRIPT: no session or no lines is skipped, never a clean trajectory", async () => {
  const prompts: string[] = [];
  const deps = {
    runner: runner(respond(focus(9)), prompts),
    now: () => NOW,
    readLines: async () => [] as unknown[],
  };
  const none = await performTrajectoryVerdict(run({ sessionId: null }), JUDGED, deps);
  assert.equal(none?.status, "skipped");
  assert.match(none?.error ?? "", /no transcript/);
  assert.equal(none?.trajectory?.signals.transcript, "missing");
  const empty = await performTrajectoryVerdict(run({ id: "run-2" }), JUDGED, deps);
  assert.equal(empty?.status, "skipped");
  assert.equal(prompts.length, 0, "nothing to judge, nothing spent");
});

test("a busy or budget-blocked runner writes nothing, so the run is tried again", async () => {
  // Hold the runner's only slot with a pass that finishes only when released.
  let release: (r: { code: number; stdout: string; error: null }) => void = () => {};
  let spawned: () => void = () => {};
  const started = new Promise<void>((r) => (spawned = r));
  const hold = createAnalysisRunner({
    spawn: () => {
      spawned();
      return { kill: () => {}, done: new Promise((r) => (release = r)) };
    },
    now: () => NOW,
    blocked: async () => false,
    meter: async () => {},
  });
  const held = hold.run({ kind: "verdict", prompt: "p", cwd: "/tmp" }, () => null);
  await started;
  const deps = { runner: hold, now: () => NOW, readLines: async () => lines(["ls"]) };
  assert.equal(await performTrajectoryVerdict(run(), JUDGED, deps), null);
  release({ code: 0, stdout: "", error: null });
  await held;
  const blocked = createAnalysisRunner({
    spawn: respond(focus(9)),
    now: () => NOW,
    blocked: async () => true,
    meter: async () => {},
  });
  assert.equal(await performTrajectoryVerdict(run(), JUDGED, { ...deps, runner: blocked }), null);
  assert.equal(await readVerdict("run-1", "trajectory"), null);
  // Disabled analysis is not transient: it is recorded as skipped.
  process.env.ARGUS_ANALYSIS = "off";
  const off = await performTrajectoryVerdict(run(), JUDGED, {
    ...deps,
    runner: runner(respond(focus(9))),
  });
  assert.equal(off?.status, "skipped");
});

test("the trajectory prompt quotes the head and tail of a long run and is bounded", () => {
  const many = lines(Array.from({ length: 200 }, (_, i) => `echo ${i} ${"x".repeat(300)}`));
  const rec = buildRecording(run(), many, NOW);
  const prompt = buildTrajectoryPrompt(run(), JUDGED, rec, computeTrajectorySignals(rec, "/repo"));
  assert.match(prompt, /events omitted/);
  assert.match(prompt, /echo 0 /);
  assert.match(prompt, /echo 199 /);
  assert.ok(prompt.length <= 24_000);
});

// ── Incomplete input (review correction) ────────────────────────────────────

/**
 * A run whose only destructive command is its very first action, followed by
 * enough ordinary activity that the Recorder keeps only the tail: the command
 * is outside the retained window.
 */
function longRunWithEarlyDestruction(): unknown[] {
  return lines([
    "rm -rf /repo/build",
    ...Array.from({ length: EVENT_CAP + 50 }, (_, i) => `echo ${i}`),
  ]);
}

test("REGRESSION: a destructive command outside the retained window cannot pass a holdOn requirement", () => {
  const rec = buildRecording(run(), longRunWithEarlyDestruction(), NOW);
  assert.equal(rec.truncated, true, "the Recorder dropped the earliest events");
  const signals = computeTrajectorySignals(rec, "/repo");
  assert.equal(signals.truncated, true);
  const destructive = signals.signals.find((x) => x.kind === "destructive-command")!;
  assert.equal(destructive.observed, false, "the command is not in what was kept");

  const rubric: Rubric = {
    goal: "g",
    criteria: [{ id: "q", label: "Q" }],
    trajectory: { check: { holdOn: ["destructive-command"] } },
  };
  const stored: Verdict = {
    ...v("r1", { kind: "trajectory", score: null }),
    id: "VT-1",
    rubricDigest: trajectoryRubricDigest(rubric),
    trajectory: { signals, held: heldSignals(signals, ["destructive-command"]), judged: false },
  };
  assert.deepEqual(
    stored.trajectory?.held,
    [],
    "nothing was observed — which is not the same as clean",
  );
  const got = trajectoryBasisEntry(stored, rubric, "r1", "s");
  assert.equal(got.ok, false);
  assert.equal(
    got.ok ? null : got.reason,
    "trajectory-signals-truncated",
    "insufficient input, not a violation",
  );

  // The same run with a complete recording and no destruction is clean.
  const clean = computeTrajectorySignals(
    buildRecording(run(), lines(["ls", "npm test"]), NOW),
    "/repo",
  );
  const cleanBasis = trajectoryBasisEntry(
    { ...stored, trajectory: { signals: clean, held: [], judged: false } },
    rubric,
    "r1",
    "s",
  );
  assert.equal(cleanBasis.ok, true);
  // And a missing recording is insufficient too.
  const missing = trajectoryBasisEntry(
    { ...stored, trajectory: { signals: missingTrajectorySignals(), held: [], judged: false } },
    rubric,
    "r1",
    "s",
  );
  assert.equal(missing.ok ? null : missing.reason, "trajectory-signals-unavailable");
});

test("REGRESSION: the trajectory PhaseCheck cannot pass over a truncated recording either", () => {
  const signals = computeTrajectorySignals(
    buildRecording(run(), longRunWithEarlyDestruction(), NOW),
    "/repo",
  );
  const check = { thresholds: { "destructive-command": 0 } };
  const optional = evaluateTrajectoryCheck(check, [{ runId: "r1", signals }]);
  assert.equal(optional.status, "not-evaluated");
  assert.match(optional.detail, /truncated/);
  const required = evaluateTrajectoryCheck({ ...check, requireTranscript: true }, [
    { runId: "r1", signals },
  ]);
  assert.deepEqual(
    [required.status, required.status === "failed" ? required.reason : null],
    ["failed", "insufficient-input"],
  );
});

const sig = (
  counts: Partial<Record<string, number>>,
  over: Partial<TrajectorySignals> = {},
): TrajectorySignals => ({
  version: TRAJECTORY_SIGNALS_VERSION,
  transcript: "present",
  events: 10,
  truncated: false,
  signals: (["repetition", "errors", "edit-revert", "path", "destructive-command"] as const).map(
    (kind) => ({
      kind,
      count: counts[kind] ?? 0,
      observed: (counts[kind] ?? 0) > 0,
      examples: [],
    }),
  ),
  ...over,
});

test("trajectory PhaseCheck: within thresholds passes; over a threshold is an observed violation", () => {
  const check = { thresholds: { errors: 2, "destructive-command": 0 } };
  assert.equal(
    evaluateTrajectoryCheck(check, [{ runId: "a", signals: sig({ errors: 2 }) }]).status,
    "passed",
  );
  const over = evaluateTrajectoryCheck(check, [
    { runId: "a", signals: sig({ errors: 1 }) },
    { runId: "b", signals: sig({ "destructive-command": 1 }) },
  ]);
  assert.equal(over.status, "failed");
  assert.equal(over.status === "failed" ? over.reason : null, "violation");
  assert.match(over.detail, /b: destructive-command 1 > 0/);
  // A violation in what a truncated recording kept is still observed.
  const truncatedViolation = evaluateTrajectoryCheck(check, [
    { runId: "a", signals: sig({ errors: 5 }, { truncated: true }) },
  ]);
  assert.equal(
    truncatedViolation.status === "failed" ? truncatedViolation.reason : null,
    "violation",
  );
  // Signals the check does not name are not judged.
  assert.equal(
    evaluateTrajectoryCheck({ thresholds: { errors: 9 } }, [
      { runId: "a", signals: sig({ repetition: 50 }) },
    ]).status,
    "passed",
  );
});

test("trajectory PhaseCheck: missing input is not-evaluated unless a transcript is required, and never passed", () => {
  const check = { thresholds: { errors: 0 } };
  const inputs = [
    { runId: "a", signals: sig({}) },
    { runId: "b", signals: null, unavailable: "no session recorded for the run" },
  ];
  const optional = evaluateTrajectoryCheck(check, inputs);
  assert.equal(optional.status, "not-evaluated");
  assert.match(optional.detail, /b: no session recorded/);
  const required = evaluateTrajectoryCheck({ ...check, requireTranscript: true }, inputs);
  assert.equal(required.status === "failed" ? required.reason : null, "insufficient-input");
  // No runs at all is not a pass.
  assert.equal(evaluateTrajectoryCheck(check, []).status, "not-evaluated");
  // A violation outranks missing input elsewhere: it was observed.
  const both = evaluateTrajectoryCheck(check, [
    { runId: "a", signals: sig({ errors: 1 }) },
    { runId: "b", signals: null },
  ]);
  assert.equal(both.status === "failed" ? both.reason : null, "violation");
});
