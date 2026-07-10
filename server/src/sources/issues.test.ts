import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildIssues,
  clearTriage,
  fingerprintOf,
  isFailure,
  issueOccurrences,
  normalizeError,
  readTriage,
  setTriage,
  IssueValidationError,
  OCCURRENCE_CAP,
} from "./issues.js";
import type { Run } from "./scheduleTypes.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-issues-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
});

let seq = 0;
function failedRun(over: Partial<Run> = {}): Run {
  const iso = new Date(2026, 6, 1, 8, ++seq).toISOString();
  return {
    id: `r${seq}`,
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "p",
    cwd: "/tmp",
    status: "failed",
    trigger: "scheduled",
    queuedAt: iso,
    startedAt: iso,
    endedAt: iso,
    durationMs: 1000,
    pid: null,
    exitCode: 1,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: "boom",
    ...over,
  };
}

test("normalizeError collapses numbers, hex ids, uuids, and timestamps", () => {
  assert.equal(normalizeError("Timeout after 42s"), "timeout after #s");
  assert.equal(normalizeError("Timeout after 7s"), "timeout after #s");
  assert.equal(
    normalizeError("run 550e8400-e29b-41d4-a716-446655440000 died at 2026-07-01T08:15:00Z"),
    "run # died at #",
  );
  assert.equal(normalizeError("commit deadbeef42 broke it"), "commit # broke it");
});

test("fingerprint groups variable messages, separates distinct ones", () => {
  const a = fingerprintOf(failedRun({ error: "timeout after 42s" }));
  const b = fingerprintOf(failedRun({ error: "Timeout after 7s" }));
  const c = fingerprintOf(failedRun({ error: "claude: command not found" }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("isFailure covers failed, interrupted, and work-level outcomes; not cancelled", () => {
  assert.ok(isFailure(failedRun()));
  assert.ok(isFailure(failedRun({ status: "interrupted", error: null })));
  assert.ok(
    isFailure(failedRun({ status: "succeeded", exitCode: 0, error: null, outcome: "failed" })),
  );
  assert.ok(
    isFailure(failedRun({ status: "succeeded", exitCode: 0, error: null, outcome: "blocked" })),
  );
  assert.ok(!isFailure(failedRun({ status: "cancelled" })));
  assert.ok(!isFailure(failedRun({ status: "succeeded", exitCode: 0, error: null })));
});

test("buildIssues groups by fingerprint across schedules with counts and seen range", () => {
  const runs = [
    failedRun({ error: "timeout after 9s", scheduleName: "beta", scheduleId: "s2" }),
    failedRun({ error: "timeout after 42s" }),
    failedRun({ error: "disk full" }),
  ].sort((x, y) => y.queuedAt.localeCompare(x.queuedAt)); // newest first, like readRuns
  const issues = buildIssues(runs, []);
  assert.equal(issues.length, 2);
  const timeout = issues.find((i) => i.title.toLowerCase().startsWith("timeout"))!;
  assert.equal(timeout.count, 2);
  assert.deepEqual(timeout.schedules.sort(), ["Nightly triage", "beta"]);
  assert.ok(timeout.firstSeen < timeout.lastSeen);
  assert.equal(timeout.state, "open");
});

test("succeeded runs never appear in issues", () => {
  const ok = failedRun({ status: "succeeded", exitCode: 0, error: null });
  assert.deepEqual(buildIssues([ok], []), []);
});

test("resolved sticks until a newer failure regresses it; ignored always sticks", () => {
  const older = failedRun({ error: "boom" });
  const newer = failedRun({ error: "boom" });
  const fp = fingerprintOf(older);

  const resolvedAfter = {
    fingerprint: fp,
    state: "resolved" as const,
    at: "x",
    lastSeenAtTriage: newer.endedAt!,
  };
  assert.equal(buildIssues([newer, older], [resolvedAfter])[0].state, "resolved");

  const resolvedBefore = {
    fingerprint: fp,
    state: "resolved" as const,
    at: "x",
    lastSeenAtTriage: older.endedAt!,
  };
  assert.equal(buildIssues([newer, older], [resolvedBefore])[0].state, "open");

  const ignored = {
    fingerprint: fp,
    state: "ignored" as const,
    at: "x",
    lastSeenAtTriage: older.endedAt!,
  };
  assert.equal(buildIssues([newer, older], [ignored])[0].state, "ignored");
});

test("issues sort open first, then by recency", () => {
  const a = failedRun({ error: "aaa" });
  const b = failedRun({ error: "bbb" }); // newer
  const fpB = fingerprintOf(b);
  const issues = buildIssues(
    [b, a],
    [{ fingerprint: fpB, state: "ignored", at: "x", lastSeenAtTriage: b.endedAt! }],
  );
  assert.deepEqual(
    issues.map((i) => i.state),
    ["open", "ignored"],
  );
});

test("issueOccurrences returns matching failures newest first, capped", () => {
  const runs = Array.from({ length: OCCURRENCE_CAP + 5 }, () =>
    failedRun({ error: "boom 123" }),
  ).sort((x, y) => y.queuedAt.localeCompare(x.queuedAt));
  const fp = fingerprintOf(runs[0]);
  const occ = issueOccurrences(runs, fp);
  assert.equal(occ.length, OCCURRENCE_CAP);
  assert.equal(occ[0].runId, runs[0].id);
  assert.equal(occ[0].error, "boom 123");
});

test("triage round-trips through the store and clearTriage reopens", async () => {
  const rec = await setTriage("aaaaaaaaaaaaaaaa", "resolved", "2026-07-01T08:00:00Z", new Date());
  assert.equal(rec.state, "resolved");
  assert.equal((await readTriage()).length, 1);

  await setTriage("aaaaaaaaaaaaaaaa", "ignored", "2026-07-01T08:00:00Z", new Date());
  const list = await readTriage();
  assert.equal(list.length, 1); // replaced, not duplicated
  assert.equal(list[0].state, "ignored");

  assert.equal(await clearTriage("aaaaaaaaaaaaaaaa"), true);
  assert.equal(await clearTriage("aaaaaaaaaaaaaaaa"), false);
  assert.equal((await readTriage()).length, 0);
});

test("setTriage rejects malformed fingerprints", async () => {
  await assert.rejects(
    () => setTriage("../evil", "resolved", "x", new Date()),
    IssueValidationError,
  );
});
