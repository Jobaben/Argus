import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  RESOLVED_RETENTION_MS,
  SentinelValidationError,
  TIMELINE_CAP,
  acknowledge,
  addNote,
  deriveConditions,
  inQuietHours,
  readPolicy,
  reconcileIncidents,
  resolveByHand,
  shouldNotify,
  summarize,
  updatePolicy,
  validatePolicyPatch,
  type Condition,
  type Incident,
  type SentinelPolicy,
} from "./sentinel.js";
import type { Anomaly } from "./watchtower.js";
import type { Issue } from "./issues.js";
import type { MonitorHealth } from "./monitors.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-sentinel-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
});

const NOW = new Date("2026-07-20T12:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const POLICY: SentinelPolicy = {
  ...DEFAULT_POLICY,
  levels: [
    { afterMinutes: 0, label: "Notify" },
    { afterMinutes: 30, label: "Escalate" },
    { afterMinutes: 60, label: "Page" },
  ],
};

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

// ── Conditions ──────────────────────────────────────────────────────────────

const monitor = (over: Partial<MonitorHealth> = {}): MonitorHealth => ({
  scheduleId: "s1",
  name: "Nightly triage",
  enabled: true,
  status: "up",
  uptimePct: 100,
  lastRunAt: null,
  lastRunStatus: null,
  expectedAt: null,
  nextExpected: null,
  graceMs: 0,
  heartbeats: [],
  ...over,
});

const issue = (over: Partial<Issue> = {}): Issue => ({
  fingerprint: "abcdef0123456789",
  title: "timeout",
  count: 3,
  firstSeen: NOW.toISOString(),
  lastSeen: NOW.toISOString(),
  schedules: ["Nightly triage"],
  state: "open",
  lastRunId: "r1",
  members: ["abcdef0123456789"],
  failureClass: null,
  ...over,
});

const anomaly = (over: Partial<Anomaly> = {}): Anomaly => ({
  id: "schedule:s1|cost|r1",
  key: "schedule:s1",
  scope: "schedule",
  name: "Nightly triage",
  runId: "r1",
  scheduleId: "s1",
  metric: "cost",
  direction: "high",
  severity: "critical",
  value: 1,
  median: 0.1,
  ratio: 10,
  zScore: null,
  at: NOW.toISOString(),
  detail: "10× median cost",
  ...over,
});

const noResolved = new Set<string>();

test("a down monitor is critical, a failing one is a warning", () => {
  const conditions = deriveConditions({
    monitors: [monitor({ status: "down" }), monitor({ scheduleId: "s2", status: "failing" })],
    issues: [],
    anomalies: [],
    resolvedFingerprints: noResolved,
  });
  assert.equal(conditions.length, 2);
  assert.equal(conditions[0].severity, "critical");
  assert.equal(conditions[1].severity, "warning");
});

test("healthy, late and paused monitors raise nothing", () => {
  const conditions = deriveConditions({
    monitors: [
      monitor({ status: "up" }),
      monitor({ scheduleId: "s2", status: "late" }),
      monitor({ scheduleId: "s3", status: "paused" }),
      monitor({ scheduleId: "s4", status: "pending" }),
    ],
    issues: [],
    anomalies: [],
    resolvedFingerprints: noResolved,
  });
  assert.deepEqual(conditions, []);
});

test("regression: only a *regressed* issue pages, not every open one", () => {
  // Mirroring the whole Issues list here would make the incident view a second
  // inbox. What pages is a change for the worse: marked fixed, came back.
  const plain = deriveConditions({
    monitors: [],
    issues: [issue()],
    anomalies: [],
    resolvedFingerprints: noResolved,
  });
  assert.deepEqual(plain, []);

  const regressed = deriveConditions({
    monitors: [],
    issues: [issue()],
    anomalies: [],
    resolvedFingerprints: new Set(["abcdef0123456789"]),
  });
  assert.equal(regressed.length, 1);
  assert.equal(regressed[0].source, "issue-regression");
  assert.match(regressed[0].title, /^Regressed:/);
});

test("only critical anomalies page", () => {
  const conditions = deriveConditions({
    monitors: [],
    issues: [],
    anomalies: [anomaly(), anomaly({ id: "b", severity: "warn" })],
    resolvedFingerprints: noResolved,
  });
  assert.equal(conditions.length, 1);
});

// ── Reconciliation ──────────────────────────────────────────────────────────

test("a new condition opens exactly one incident, with an opening timeline entry", () => {
  const { incidents, alerts } = reconcileIncidents([], [condition()], POLICY, NOW);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].status, "open");
  assert.equal(incidents[0].level, 0);
  assert.equal(incidents[0].timeline[0].kind, "opened");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, "incident.opened");
});

test("regression: a condition that persists does not open a second incident", () => {
  // A monitor down for six hours is one incident with a six-hour timeline, not
  // seventy-two alerts. The whole point of the object is to not repeat.
  const first = reconcileIncidents([], [condition()], POLICY, NOW);
  const second = reconcileIncidents(first.incidents, [condition()], POLICY, later(1));
  assert.equal(second.incidents.length, 1);
  assert.equal(second.incidents[0].id, first.incidents[0].id);
  assert.equal(second.alerts.length, 0);
});

test("an unacknowledged incident escalates on the clock, one level at a time", () => {
  const opened = reconcileIncidents([], [condition()], POLICY, NOW).incidents;
  assert.equal(opened[0].nextEscalationAt, later(30).toISOString());

  const tooEarly = reconcileIncidents(opened, [condition()], POLICY, later(29));
  assert.equal(tooEarly.incidents[0].level, 0);
  assert.equal(tooEarly.alerts.length, 0);

  const escalated = reconcileIncidents(opened, [condition()], POLICY, later(31));
  assert.equal(escalated.incidents[0].level, 1);
  assert.equal(escalated.alerts[0].event, "incident.escalated");
  assert.equal(escalated.incidents[0].timeline.at(-1)?.detail, "Escalate");

  // And it keeps climbing until the policy runs out.
  const paged = reconcileIncidents(escalated.incidents, [condition()], POLICY, later(200));
  assert.equal(paged.incidents[0].level, 2);
  assert.equal(paged.incidents[0].nextEscalationAt, null, "fully climbed");
});

test("regression: acknowledging stops the escalation clock", () => {
  const opened = reconcileIncidents([], [condition()], POLICY, NOW).incidents;
  const acked = [acknowledge(opened[0], "ada", later(1))];
  assert.equal(acked[0].nextEscalationAt, null);

  const after = reconcileIncidents(acked, [condition()], POLICY, later(300));
  assert.equal(after.incidents[0].level, 0, "an acknowledged incident does not escalate");
  assert.equal(after.alerts.length, 0);
});

test("a cleared condition resolves the incident, once", () => {
  const opened = reconcileIncidents([], [condition()], POLICY, NOW).incidents;
  const cleared = reconcileIncidents(opened, [], POLICY, later(5));
  assert.equal(cleared.incidents[0].status, "resolved");
  assert.equal(cleared.alerts[0].event, "incident.resolved");

  const again = reconcileIncidents(cleared.incidents, [], POLICY, later(6));
  assert.equal(again.alerts.length, 0, "already resolved — nothing more to say");
});

test("regression: a recurrence reopens the same incident rather than opening a twin", () => {
  const opened = reconcileIncidents([], [condition()], POLICY, NOW).incidents;
  const resolved = reconcileIncidents(opened, [], POLICY, later(5)).incidents;
  const recurred = reconcileIncidents(resolved, [condition()], POLICY, later(10));

  assert.equal(recurred.incidents.length, 1);
  assert.equal(
    recurred.incidents[0].id,
    opened[0].id,
    "the history of a recurring problem is the useful part",
  );
  assert.equal(recurred.incidents[0].status, "open");
  assert.equal(recurred.incidents[0].resolvedAt, null);
  assert.equal(recurred.incidents[0].level, 0, "the escalation clock restarts");
  assert.ok(recurred.incidents[0].timeline.some((e) => e.kind === "reopened"));
  assert.match(recurred.alerts[0].detail, /recurred/);
});

test("resolving by hand sticks only while the condition is gone", () => {
  const opened = reconcileIncidents([], [condition()], POLICY, NOW).incidents;
  const byHand = [resolveByHand(opened[0], "ada", "false alarm", later(1))];
  assert.equal(byHand[0].status, "resolved");
  assert.equal(byHand[0].timeline.at(-1)?.by, "user:ada");

  // The condition is still live, so the next tick reopens it — and says so in
  // the timeline rather than silently undoing the click.
  const next = reconcileIncidents(byHand, [condition()], POLICY, later(2));
  assert.equal(next.incidents[0].status, "open");
  assert.ok(next.incidents[0].timeline.some((e) => e.kind === "reopened"));
});

test("resolved incidents age out, and the timeline is capped", () => {
  const opened = reconcileIncidents([], [condition()], POLICY, NOW).incidents;
  const resolved = reconcileIncidents(opened, [], POLICY, later(1)).incidents;
  const muchLater = new Date(NOW.getTime() + RESOLVED_RETENTION_MS + 3_600_000);
  assert.equal(reconcileIncidents(resolved, [], POLICY, muchLater).incidents.length, 0);

  let noisy = opened[0];
  for (let i = 0; i < TIMELINE_CAP + 20; i++) {
    noisy = addNote(noisy, "ada", `note ${i}`, later(i));
  }
  assert.equal(noisy.timeline.length, TIMELINE_CAP);
  assert.equal(noisy.timeline.at(-1)?.detail, `note ${TIMELINE_CAP + 19}`);
});

test("live incidents sort above resolved ones", () => {
  const two = reconcileIncidents(
    [],
    [condition(), condition({ key: "monitor:s2", title: "Other" })],
    POLICY,
    NOW,
  ).incidents;
  const mixed = reconcileIncidents(
    two,
    [condition({ key: "monitor:s2", title: "Other" })],
    POLICY,
    later(1),
  );
  assert.equal(mixed.incidents[0].status, "open");
  assert.equal(mixed.incidents[1].status, "resolved");
});

// ── Quiet hours ─────────────────────────────────────────────────────────────

test("quiet hours wrap past midnight", () => {
  const quiet = { start: "22:00", end: "07:00" };
  const at = (h: number, m = 0) => new Date(2026, 6, 20, h, m);
  assert.equal(inQuietHours(quiet, at(23)), true);
  assert.equal(inQuietHours(quiet, at(3)), true);
  assert.equal(inQuietHours(quiet, at(6, 59)), true);
  assert.equal(inQuietHours(quiet, at(7)), false);
  assert.equal(inQuietHours(quiet, at(12)), false);
  assert.equal(inQuietHours(null, at(3)), false);
});

test("a same-day quiet window does not wrap", () => {
  const quiet = { start: "09:00", end: "17:00" };
  const at = (h: number) => new Date(2026, 6, 20, h);
  assert.equal(inQuietHours(quiet, at(12)), true);
  assert.equal(inQuietHours(quiet, at(20)), false);
  assert.equal(inQuietHours(quiet, at(3)), false);
});

test("regression: quiet hours suppress the bell, never the record", () => {
  const quiet: SentinelPolicy = {
    ...POLICY,
    quietHours: { start: "00:00", end: "23:59" },
    quietHoursOverrideCritical: false,
  };
  const { incidents, alerts } = reconcileIncidents(
    [],
    [condition({ severity: "warning" })],
    quiet,
    new Date(2026, 6, 20, 3),
  );
  assert.equal(alerts[0].suppressed, true, "the bell stays silent");
  assert.equal(incidents[0].timeline.length, 1, "the timeline still has the opening");
  assert.equal(incidents[0].status, "open", "and the incident is still live");
});

test("criticals can override quiet hours; warnings cannot", () => {
  const night = new Date(2026, 6, 20, 3);
  const quiet: SentinelPolicy = { ...POLICY, quietHours: { start: "22:00", end: "07:00" } };
  assert.equal(shouldNotify(quiet, "critical", night), true);
  assert.equal(shouldNotify(quiet, "warning", night), false);
  assert.equal(
    shouldNotify({ ...quiet, quietHoursOverrideCritical: false }, "critical", night),
    false,
  );
  assert.equal(shouldNotify(quiet, "warning", new Date(2026, 6, 20, 12)), true);
});

// ── Policy persistence ──────────────────────────────────────────────────────

test("the default policy is usable without configuration", async () => {
  const policy = await readPolicy();
  assert.equal(policy.enabled, true);
  assert.ok(policy.levels.length >= 2, "one level is not an escalation policy");
  assert.equal(policy.quietHours, null);
  assert.equal(policy.autoDiagnose, false, "spawning agents is never the default");
});

test("policy updates round-trip and validate", async () => {
  const saved = await updatePolicy(
    validatePolicyPatch({
      levels: [{ afterMinutes: 0, label: "Notify" }],
      quietHours: { start: "22:00", end: "07:00" },
      autoDiagnose: true,
    }),
  );
  assert.equal(saved.levels.length, 1);
  assert.equal(saved.autoDiagnose, true);
  assert.deepEqual((await readPolicy()).quietHours, { start: "22:00", end: "07:00" });

  assert.deepEqual(validatePolicyPatch({ quietHours: null }).quietHours, null);
});

test("an unusable policy is rejected with a message that says what to fix", () => {
  assert.throws(() => validatePolicyPatch({ levels: [] }), /at least one/);
  assert.throws(
    () => validatePolicyPatch({ levels: [{ afterMinutes: -1, label: "x" }] }),
    /0 or more/,
  );
  assert.throws(() => validatePolicyPatch({ levels: [{ afterMinutes: 0 }] }), /label is required/);
  assert.throws(
    () => validatePolicyPatch({ quietHours: { start: "25:00", end: "07:00" } }),
    /HH:MM/,
  );
  assert.throws(
    () => validatePolicyPatch({ quietHours: { start: "07:00", end: "07:00" } }),
    /different from its start/,
  );
  assert.throws(() => validatePolicyPatch("nope"), SentinelValidationError);
});

test("summarize counts live severity, not historical", () => {
  const incidents: Incident[] = [
    { ...reconcileIncidents([], [condition()], POLICY, NOW).incidents[0] },
    {
      ...reconcileIncidents([], [condition({ key: "k2" })], POLICY, NOW).incidents[0],
      status: "resolved",
    },
  ];
  const s = summarize(incidents);
  assert.equal(s.open, 1);
  assert.equal(s.resolved, 1);
  assert.equal(s.critical, 1, "a resolved critical is not a live critical");
});
