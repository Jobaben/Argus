import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSentinelWatcher } from "./sentinelWatcher.js";
import {
  acknowledge,
  readIncidents,
  updatePolicy,
  withIncidentLock,
  writeIncidents,
  type Condition,
  type IncidentAlert,
} from "./sources/sentinel.js";
import { createAnalysisRunner, type AnalysisSpawn } from "./sources/analysis.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-sentinelw-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_ANALYSIS;
});

const NOW = new Date("2026-07-20T12:00:00.000Z");

const condition = (over: Partial<Condition> = {}): Condition => ({
  key: "monitor:s1",
  source: "monitor-down",
  severity: "critical",
  title: "Nightly triage",
  detail: "no run covered the expected slot",
  scheduleId: "s1",
  runId: null,
  fingerprint: null,
  ...over,
});

const DIAGNOSIS = JSON.stringify({
  findings: "The CLI is not on PATH.",
  remediation: "Fix PATH and re-run.",
  confidence: 0.7,
});

const respond =
  (stdout: string): AnalysisSpawn =>
  () => ({ kill: () => {}, done: Promise.resolve({ code: 0, stdout, error: null }) });

function watcher(conditions: Condition[], now = () => NOW) {
  const alerts: IncidentAlert[] = [];
  const w = createSentinelWatcher({
    now,
    conditions: async () => conditions,
    onAlert: (a) => alerts.push(a),
    diagnose: {
      runner: createAnalysisRunner({
        spawn: respond(JSON.stringify({ result: DIAGNOSIS, total_cost_usd: 0.001 })),
        now,
        meter: async () => {},
      }),
      now,
      context: async () => [],
    },
  });
  return { w, alerts };
}

test("incidents persist across ticks, so a restart resumes mid-incident", async () => {
  const { w } = watcher([condition()]);
  await w.check();
  const stored = await readIncidents();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "open");

  // A fresh watcher — as after a restart — reads the same incident rather than
  // opening a second one.
  const { w: reborn, alerts } = watcher([condition()]);
  await reborn.check();
  assert.equal((await readIncidents()).length, 1);
  assert.equal(alerts.length, 0, "a restart is not a new incident");
});

test("a disabled policy does nothing at all", async () => {
  await updatePolicy({ enabled: false });
  const { w, alerts } = watcher([condition()]);
  await w.check();
  assert.deepEqual(await readIncidents(), []);
  assert.equal(alerts.length, 0);
});

test("autoDiagnose is off by default — spawning an agent is never the default", async () => {
  const { w } = watcher([condition()]);
  await w.check();
  assert.equal((await readIncidents())[0].diagnosis, null);
});

test("with autoDiagnose on, a freshly-opened incident gets a read-only diagnosis attached", async () => {
  await updatePolicy({ autoDiagnose: true });
  const { w } = watcher([condition()]);
  await w.check();
  const [incident] = await readIncidents();
  assert.equal(incident.diagnosis?.status, "ready");
  assert.match(incident.diagnosis?.findings ?? "", /not on PATH/);
  assert.match(incident.diagnosis?.remediation ?? "", /Fix PATH/);
  assert.ok(incident.timeline.some((e) => e.kind === "diagnosed"));
  // The proposal is attached, and nothing was executed.
  assert.equal(incident.status, "open");
});

test("a diagnosis is dispatched only for newly-opened incidents, not on every tick", async () => {
  await updatePolicy({ autoDiagnose: true });
  const { w } = watcher([condition()]);
  await w.check();
  const first = (await readIncidents())[0].diagnosis?.at;
  await w.check();
  assert.equal((await readIncidents())[0].diagnosis?.at, first, "not re-diagnosed");
});

test("regression: an acknowledgement landing during the diagnostic is not clobbered", async () => {
  await updatePolicy({ autoDiagnose: true });
  const alerts: IncidentAlert[] = [];
  // A spawn that lets us acknowledge the incident *while* the pass is running,
  // which is the whole reason the attach re-reads under the lock.
  const racingSpawn: AnalysisSpawn = () => ({
    kill: () => {},
    done: (async () => {
      await withIncidentLock(async () => {
        const list = await readIncidents();
        if (list[0]) {
          list[0] = acknowledge(list[0], "ada", NOW);
          await writeIncidents(list);
        }
      });
      return {
        code: 0,
        stdout: JSON.stringify({ result: DIAGNOSIS, total_cost_usd: 0.001 }),
        error: null,
      };
    })(),
  });

  const w = createSentinelWatcher({
    now: () => NOW,
    conditions: async () => [condition()],
    onAlert: (a) => alerts.push(a),
    diagnose: {
      runner: createAnalysisRunner({ spawn: racingSpawn, now: () => NOW, meter: async () => {} }),
      now: () => NOW,
      context: async () => [],
    },
  });
  await w.check();

  const [incident] = await readIncidents();
  assert.equal(incident.status, "acknowledged", "the human's edit survived");
  assert.equal(incident.acknowledgedBy, "ada");
  assert.equal(incident.diagnosis?.status, "ready", "and the diagnosis still attached");
});

test("a conditions failure is swallowed rather than wedging the scheduler tick", async () => {
  const w = createSentinelWatcher({
    now: () => NOW,
    conditions: () => Promise.reject(new Error("disk gone")),
    onAlert: () => assert.fail("nothing should alert"),
  });
  await w.check();
});

test("an alert handler that throws does not stop the remaining alerts", async () => {
  let seen = 0;
  const w = createSentinelWatcher({
    now: () => NOW,
    conditions: async () => [condition(), condition({ key: "monitor:s2", title: "Other" })],
    onAlert: () => {
      seen++;
      if (seen === 1) throw new Error("bell exploded");
    },
  });
  await w.check();
  assert.equal(seen, 2);
});
