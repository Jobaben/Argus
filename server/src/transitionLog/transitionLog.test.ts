import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyOps,
  diffProjection,
  isElided,
  projectInstance,
  projectionDigest,
  statusChanges,
  statusView,
  ReplayError,
} from "./projection.js";
import {
  compareIntegrity,
  encodeTransition,
  foldTransitions,
  TRANSITION_RECORD_MAX_BYTES,
  type LogReading,
} from "./fold.js";
import { appendTransitionRecord, readTransitionLog, transitionLogPath } from "./store.js";
import { atomicWriteFileDurable } from "../sources/atomicWrite.js";
import { pruneInstances, writeInstance } from "../sources/instances.js";
import type { PipelineInstance, TransitionRecord } from "@argus/contracts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-transitions-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

function instance(over: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "inst1",
    pipelineId: "p1",
    pipelineName: "Pipe",
    status: "running",
    currentPhaseIndex: 0,
    phases: [
      {
        id: "a",
        name: "A",
        gated: false,
        status: "running",
        steps: [{ name: "s", runId: "r1", status: "running" }],
        attempt: 0,
        retries: 0,
        payload: null,
      },
      {
        id: "b",
        name: "B",
        gated: true,
        status: "pending",
        steps: [{ name: "t", runId: null, status: "pending" }],
        attempt: 0,
        retries: 0,
        payload: null,
      },
    ],
    trigger: "manual",
    signalToken: "legacy",
    signalScheme: "run-token-v1",
    createdAt: "2026-10-04T12:00:00.000Z",
    updatedAt: "2026-10-04T12:00:00.000Z",
    endedAt: null,
    artifacts: {},
    definition: {
      id: "p1",
      name: "Pipe",
      phases: [],
      trigger: null,
      enabled: true,
      overlapPolicy: "skip",
      lastStartedAt: null,
      createdAt: "x",
      updatedAt: "x",
    },
    ...over,
  };
}

/** A minimal, correct chain: init baseline then each later state's diff. */
function chain(states: PipelineInstance[], instanceId = "inst1"): TransitionRecord[] {
  const out: TransitionRecord[] = [];
  let prev: unknown = null;
  states.forEach((s, i) => {
    const p = projectInstance(s);
    out.push({
      schema: 1,
      seq: i + 1,
      instanceId,
      at: `2026-10-04T12:00:0${i}.000Z`,
      source: i === 0 ? "start" : "signal",
      events: [{ kind: i === 0 ? "init" : "signal" }],
      ...(i === 0 ? { baseline: p } : { changes: diffProjection(prev, p) }),
      effects: [],
      stateSha256: projectionDigest(p),
    });
    prev = p;
  });
  return out;
}

function reading(records: TransitionRecord[], over: Partial<LogReading> = {}): LogReading {
  return { records, corruptLines: [], invalidLines: [], tornTail: 0, present: true, ...over };
}

function advanced(base: PipelineInstance): PipelineInstance {
  const next = structuredClone(base);
  next.phases[0].status = "succeeded";
  next.phases[0].steps[0].status = "succeeded";
  next.phases[0].payload = { last_assistant_message: "ARGUS_OUTCOME: succeeded" };
  next.phases[1].status = "running";
  next.updatedAt = "2026-10-04T12:00:05.000Z";
  return next;
}

// ── projection ───────────────────────────────────────────────────────────────

test("the projection keeps pipeline state and elides what a record cannot carry", () => {
  const big = "x".repeat(5000);
  const p = projectInstance(
    instance({
      triggerPayload: { body: "small" },
      transitionLog: { seq: 7 },
      phases: [
        {
          ...instance().phases[0],
          payload: { last_assistant_message: big },
          steps: [{ name: "s", runId: "r1", status: "running", resultError: big }],
        },
      ],
    }),
  );
  assert.ok(isElided(p.definition), "the definition is always kept by digest");
  assert.ok(isElided(p.triggerPayload), "so is the trigger payload");
  assert.equal("transitionLog" in p, false, "the log's own bookkeeping is not projected");
  const phase = (p.phases as any[])[0];
  assert.ok(isElided(phase.payload), "a large agent payload is kept by digest");
  assert.ok(isElided(phase.steps[0].resultError), "so is any long string");
  assert.equal(phase.status, "running");
  assert.equal(phase.steps[0].runId, "r1");
  // A small payload stays itself.
  const small = projectInstance(
    instance({ phases: [{ ...instance().phases[0], payload: { ok: 1 } }] }),
  );
  assert.deepEqual((small.phases as any[])[0].payload, { ok: 1 });
  // Undefined vanishes exactly as it does on disk.
  const withUndefined = projectInstance({ ...instance(), endedAt: undefined } as any);
  assert.equal("endedAt" in withUndefined, false);
});

test("a different elided value still changes the digest", () => {
  const a = instance({ triggerPayload: { n: 1 } });
  const b = instance({ triggerPayload: { n: 2 } });
  assert.notEqual(projectionDigest(projectInstance(a)), projectionDigest(projectInstance(b)));
});

test("diff then apply reproduces the target, for objects, arrays and replacements", () => {
  const before = projectInstance(instance());
  const mutations: Array<(i: PipelineInstance) => void> = [
    (i) => (i.status = "awaiting-approval"),
    (i) =>
      (i.phases[0].steps = [
        { name: "s", runId: "r2", status: "running" },
        { name: "s", runId: "r3", status: "running" },
      ]),
    (i) => delete i.phases[1].retries,
    (i) =>
      (i.pendingGateOperation = {
        decisionId: "GD-1",
        decision: "approve",
        startedAt: "t",
        phaseId: "b",
        attempt: 0,
        stopRunIds: [],
      }),
    (i) => (i.gateDecisionIds = ["GD-1", "GD-2"]),
  ];
  for (const mutate of mutations) {
    const target = instance();
    mutate(target);
    const after = projectInstance(target);
    const ops = diffProjection(before, after);
    assert.ok(ops.length > 0);
    assert.deepEqual(applyOps(before, ops), after);
  }
  assert.deepEqual(diffProjection(before, before), []);
});

test("apply is strict: a change with no parent is an error, never an implicit creation", () => {
  assert.throws(
    () => applyOps({ a: {} }, [{ op: "set", path: ["b", "c"], value: 1 }]),
    ReplayError,
  );
  assert.throws(() => applyOps({ a: [1] }, [{ op: "set", path: ["a", 5], value: 1 }]), ReplayError);
  assert.throws(() => applyOps({ a: 1 }, [{ op: "delete", path: ["z"] }]), ReplayError);
});

test("the status view covers pipeline statuses only, and names each change", () => {
  const before = statusView(instance());
  const after = statusView(advanced(instance()));
  const changes = statusChanges(before, after);
  assert.ok(changes.some((c) => c.startsWith("phase:a: running")));
  assert.ok(changes.some((c) => c.startsWith("step:a#0: r1|running")));
  assert.ok(changes.some((c) => c.startsWith("phase:b: pending")));
  // A payload change is not a status change.
  const payloadOnly = instance();
  payloadOnly.phases[0].payload = { anything: true };
  assert.deepEqual(statusChanges(before, statusView(payloadOnly)), []);
});

// ── records ──────────────────────────────────────────────────────────────────

test("a record too large for a line keeps its sequence but not its changes", () => {
  const huge = Array.from({ length: 4000 }, (_, i) => ({
    op: "set" as const,
    path: ["phases", 0, `k${i}`],
    value: i,
  }));
  const encoded = encodeTransition({
    schema: 1,
    seq: 4,
    instanceId: "inst1",
    at: "t",
    source: "signal",
    events: [{ kind: "signal", detail: "y".repeat(5000) }],
    changes: huge,
    effects: [],
    stateSha256: "0".repeat(64),
  });
  assert.equal(encoded.oversized, true);
  assert.ok(Buffer.byteLength(encoded.text) <= TRANSITION_RECORD_MAX_BYTES);
  assert.equal(encoded.record.changes, undefined);
  assert.ok(encoded.record.oversize && encoded.record.oversize.bytes > TRANSITION_RECORD_MAX_BYTES);
  assert.ok((encoded.record.events[0].detail ?? "").length <= 200);
});

test("a legitimate init baseline and a signal transition fit comfortably", () => {
  const [init, next] = chain([instance(), advanced(instance())]);
  assert.ok(Buffer.byteLength(encodeTransition(init).text) < 4096);
  assert.ok(Buffer.byteLength(encodeTransition(next).text) < 2048);
  // A wide pipeline: 40 phases of three steps each still fits a baseline.
  const wide = instance({
    phases: Array.from({ length: 40 }, (_, i) => ({
      ...instance().phases[0],
      id: `phase-${i}`,
      name: `Phase number ${i}`,
      steps: [0, 1, 2].map((j) => ({
        name: `step-${j}`,
        runId: `run-${i}-${j}`,
        status: "running" as const,
      })),
    })),
  });
  assert.equal(encodeTransition(chain([wide])[0]).oversized, false);
});

// ── fold ─────────────────────────────────────────────────────────────────────

test("a fold from the init baseline reproduces every state in turn", () => {
  const s0 = instance();
  const s1 = advanced(s0);
  const s2 = structuredClone(s1);
  s2.phases[1].status = "awaiting-approval";
  s2.status = "awaiting-approval";
  const records = chain([s0, s1, s2]);
  for (const [upto, state] of [
    [1, s0],
    [2, s1],
    [3, s2],
  ] as const) {
    const f = foldTransitions(records, upto);
    assert.equal(f.seq, upto);
    assert.equal(f.coverage, "full");
    assert.deepEqual(f.state, projectInstance(state));
  }
});

test("a fold needs a baseline, stops at a gap, and stops at an oversize record", () => {
  const records = chain([instance(), advanced(instance()), instance({ status: "failed" })]);
  const noBase = foldTransitions(records.slice(1));
  assert.equal(noBase.state, null);
  assert.equal(noBase.stopped?.reason, "no-baseline");

  const gap = foldTransitions([records[0], records[2]]);
  assert.equal(gap.seq, 1);
  assert.equal(gap.stopped?.reason, "gap");

  const oversized = [...records];
  oversized[1] = {
    ...records[1],
    changes: undefined,
    oversize: { bytes: 99999, sha256: "0".repeat(64) },
  };
  const over = foldTransitions(oversized);
  assert.equal(over.seq, 1);
  assert.equal(over.stopped?.reason, "oversize");
});

test("a later baseline re-anchors a replay after records that were never written", () => {
  const states = [instance(), advanced(instance()), instance({ status: "failed" })];
  const records = chain(states);
  const rebased: TransitionRecord = {
    ...records[2],
    seq: 5,
    changes: undefined,
    baseline: projectInstance(states[2]),
  };
  const f = foldTransitions([records[0], rebased]);
  assert.equal(f.seq, 5);
  assert.equal(f.coverage, "from-baseline");
  assert.match(f.findings.join(" "), /records 2–4 are absent/);
});

test("a record whose replay does not hash to what it recorded stops the fold", () => {
  const records = chain([instance(), advanced(instance())]);
  records[1] = { ...records[1], stateSha256: "f".repeat(64) };
  const f = foldTransitions(records);
  assert.equal(f.stopped?.reason, "replay");
});

// ── integrity ────────────────────────────────────────────────────────────────

test("integrity: consistent, ahead, behind, disagreement", () => {
  const s0 = instance();
  const s1 = advanced(s0);
  const records = chain([s0, s1]);
  const at = (inst: PipelineInstance, seq: number) => ({ ...inst, transitionLog: { seq } });

  assert.equal(compareIntegrity("inst1", at(s1, 2), reading(records)).status, "consistent");

  const ahead = compareIntegrity("inst1", at(s0, 1), reading(records));
  assert.equal(ahead.status, "ahead");
  assert.match(ahead.findings.join(" "), /proposed, never committed/);

  const behind = compareIntegrity("inst1", at(s1, 3), reading(records));
  assert.equal(behind.status, "behind");

  const changed = structuredClone(s1);
  changed.phases[1].status = "failed";
  const dis = compareIntegrity("inst1", at(changed, 2), reading(records));
  assert.equal(dis.status, "disagreement");
  assert.equal(dis.firstDivergence, "/phases/1/status");
});

test("integrity: untracked, missing, degraded, gap, corrupt, partial", () => {
  const s0 = instance();
  const s1 = advanced(s0);
  const records = chain([s0, s1]);
  const none: LogReading = {
    records: [],
    corruptLines: [],
    invalidLines: [],
    tornTail: 0,
    present: false,
  };

  assert.equal(compareIntegrity("inst1", s0, none).status, "untracked");
  assert.equal(
    compareIntegrity("inst1", { ...s0, transitionLog: { seq: 3 } }, none).status,
    "missing",
  );
  assert.equal(
    compareIntegrity(
      "inst1",
      { ...s1, transitionLog: { seq: 2, degradedFrom: 2 } },
      reading([records[0]]),
    ).status,
    "degraded",
  );
  const third = { ...structuredClone(s1), status: "failed" as const };
  const withThird = chain([s0, s1, third]);
  assert.equal(
    compareIntegrity(
      "inst1",
      { ...third, transitionLog: { seq: 3 } },
      reading([withThird[0], withThird[2]]),
    ).status,
    "gap",
  );
  assert.equal(
    compareIntegrity(
      "inst1",
      { ...s1, transitionLog: { seq: 2 } },
      reading(records, { corruptLines: [2] }),
    ).status,
    "corrupt",
  );
  const fromBaseline: TransitionRecord = { ...records[0], events: [{ kind: "baseline" }] };
  const partial = compareIntegrity(
    "inst1",
    { ...s0, transitionLog: { seq: 1 } },
    reading([fromBaseline]),
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.coverage, "from-baseline");
});

// ── storage ──────────────────────────────────────────────────────────────────

test("records round-trip through the checksummed log and fold back to the instance", async () => {
  const s0 = instance();
  const s1 = advanced(s0);
  for (const r of chain([s0, s1])) {
    const out = await appendTransitionRecord(r);
    assert.equal(out.ok, true);
  }
  const log = await readTransitionLog("inst1");
  assert.equal(log.records.length, 2);
  assert.deepEqual(log.corruptLines, []);
  assert.equal(
    compareIntegrity("inst1", { ...s1, transitionLog: { seq: 2 } }, log).status,
    "consistent",
  );
});

test("a flipped byte is corruption, not a torn write", async () => {
  for (const r of chain([instance(), advanced(instance())])) await appendTransitionRecord(r);
  const file = transitionLogPath("inst1");
  const text = readFileSync(file, "utf8").replace('"running"', '"runnin_"');
  writeFileSync(file, text);
  const log = await readTransitionLog("inst1");
  assert.deepEqual(log.corruptLines, [1]);
  assert.equal(
    compareIntegrity("inst1", { ...advanced(instance()), transitionLog: { seq: 2 } }, log).status,
    "corrupt",
  );
});

test("a torn fragment is fenced off by the next append and never read as a record", async () => {
  const [r1, r2] = chain([instance(), advanced(instance())]);
  await appendTransitionRecord(r1);
  const file = transitionLogPath("inst1");
  appendFileSync(file, '{"body":{"schema":1,"seq":2'); // a write that died mid-line
  const torn = await readTransitionLog("inst1");
  assert.ok(torn.tornTail > 0);
  assert.equal(torn.records.length, 1);
  assert.deepEqual(torn.corruptLines, []);
  await appendTransitionRecord(r2);
  const healed = await readTransitionLog("inst1");
  assert.equal(healed.records.length, 2);
  assert.deepEqual(healed.corruptLines, [], "the fenced fragment is recovered, not corrupt");
  assert.equal(healed.tornTail, 0);
});

test("a short write is completed; a write that stops making progress fails without a partial record", async () => {
  const [r1, r2] = chain([instance(), advanced(instance())]);
  let calls = 0;
  const halves = await appendTransitionRecord(r1, {
    write: (fh, data, offset, length) => {
      calls++;
      return fh.write(data, offset, Math.max(1, Math.floor(length / 2)), null);
    },
  });
  assert.equal(halves.ok, true);
  assert.ok(calls > 1);
  let n = 0;
  const stuck = await appendTransitionRecord(r2, {
    write: (fh, data, offset, length) =>
      n++ === 0
        ? fh.write(data, offset, Math.min(10, length), null)
        : Promise.resolve({ bytesWritten: 0 }),
  });
  assert.equal(stuck.ok, false);
  if (!stuck.ok) assert.equal(stuck.reason, "error");
  const log = await readTransitionLog("inst1");
  assert.equal(log.records.length, 1, "the stuck record's prefix is a torn tail, not a record");
  assert.ok(log.tornTail > 0);
  // And the next good append fences it off.
  assert.equal((await appendTransitionRecord(r2)).ok, true);
  const after = await readTransitionLog("inst1");
  assert.equal(after.records.length, 2);
  assert.deepEqual(after.corruptLines, []);
});

test("at the cap an append is refused and the log is left exactly as it was", async () => {
  const [r1, r2] = chain([instance(), advanced(instance())]);
  await appendTransitionRecord(r1);
  const file = transitionLogPath("inst1");
  const before = readFileSync(file);
  const out = await appendTransitionRecord(r2, { maxBytes: before.length + 10 });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "capped");
  assert.deepEqual(readFileSync(file), before);
});

test("readers tolerate a missing log, foreign records and an invalid instance id", async () => {
  const absent = await readTransitionLog("nobody");
  assert.equal(absent.present, false);
  const [r1] = chain([instance()], "other");
  mkdirSync(path.dirname(transitionLogPath("inst1")), { recursive: true });
  await appendTransitionRecord({ ...r1, instanceId: "other" });
  // A record for another instance copied into this one's file.
  writeFileSync(transitionLogPath("inst1"), readFileSync(transitionLogPath("other")));
  const foreign = await readTransitionLog("inst1");
  assert.deepEqual(foreign.invalidLines, [1]);
  assert.throws(() => transitionLogPath("../escape"));
  const bad = await appendTransitionRecord({ ...r1, instanceId: "../escape" });
  assert.equal(bad.ok, false);
});

test("the log is pruned with its instance, and only then", async () => {
  const keep = instance({ id: "keep", createdAt: "2026-10-04T12:00:02.000Z" });
  const drop = instance({ id: "drop", createdAt: "2026-10-04T12:00:01.000Z" });
  for (const inst of [keep, drop]) {
    await writeInstance(inst);
    await appendTransitionRecord(chain([inst], inst.id)[0]);
  }
  await pruneInstances("p1", 1);
  assert.equal(existsSync(transitionLogPath("keep")), true);
  assert.equal(existsSync(transitionLogPath("drop")), false);
});

// ── durable instance publication ─────────────────────────────────────────────

test("durable publication: a fault before the rename leaves the old file and no temp", async () => {
  const dir = path.join(home, "pub");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "x.json");
  writeFileSync(file, "old");
  await assert.rejects(
    atomicWriteFileDurable(file, "new", {
      fault: (p) => {
        if (p === "temp-synced") throw new Error("crash");
      },
    }),
    /crash/,
  );
  assert.equal(readFileSync(file, "utf8"), "old");
  assert.deepEqual(readdirSync(dir), ["x.json"]);
});

test("durable publication: a fault after the rename has already published", async () => {
  const dir = path.join(home, "pub2");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "x.json");
  await assert.rejects(
    atomicWriteFileDurable(file, "new", {
      fault: (p) => {
        if (p === "renamed") throw new Error("crash");
      },
    }),
  );
  assert.equal(readFileSync(file, "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["x.json"]);
});

test("durable publication: short writes complete, a stuck write fails cleanly", async () => {
  const dir = path.join(home, "pub3");
  const file = path.join(dir, "x.json");
  await atomicWriteFileDurable(file, "abcdefghij", {
    write: (fh, data, offset) => fh.write(data, offset, 1, null),
  });
  assert.equal(readFileSync(file, "utf8"), "abcdefghij");
  await assert.rejects(
    atomicWriteFileDurable(file, "zzz", { write: async () => ({ bytesWritten: 0 }) }),
    /no progress/,
  );
  assert.equal(readFileSync(file, "utf8"), "abcdefghij");
  assert.deepEqual(readdirSync(dir), ["x.json"]);
});

test("durable publication keeps the Windows rename retries, and cleans up when they run out", async () => {
  const dir = path.join(home, "pub4");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "x.json");
  let attempts = 0;
  const busy = Object.assign(new Error("busy"), { code: "EPERM" });
  const { rename } = await import("node:fs/promises");
  await atomicWriteFileDurable(file, "won", {
    renameDeps: {
      platform: "win32",
      sleep: async () => {},
      rename: async (from, to) => {
        if (attempts++ < 2) throw busy;
        await rename(from, to);
      },
    },
  });
  assert.equal(readFileSync(file, "utf8"), "won");
  assert.equal(attempts, 3);
  await assert.rejects(
    atomicWriteFileDurable(file, "lost", {
      renameDeps: {
        platform: "win32",
        sleep: async () => {},
        rename: async () => {
          throw busy;
        },
      },
    }),
  );
  assert.equal(readFileSync(file, "utf8"), "won");
  assert.deepEqual(readdirSync(dir), ["x.json"]);
});

test("writeInstance publishes durably and the instance reads back", async () => {
  const inst = instance({ id: "durable" });
  await writeInstance(inst);
  const file = path.join(home, "argus", "instances", "durable.json");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).id, "durable");
  assert.deepEqual(
    readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")),
    [],
  );
});
