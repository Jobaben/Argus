import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Anomaly, Incident, Verdict } from "@argus/contracts";
import type { Run } from "../sources/scheduleTypes.js";
import { closeVault, setVaultEngine } from "./db.js";
import { ingest } from "./ingest.js";
import { runsBetween, vaultQuarters, vaultSearch, vaultStatus } from "./query.js";

/**
 * The Vault's tests run against a real SQLite database in a temp home, because
 * the parts most worth testing — FTS behaviour, upsert semantics, the quarter
 * boundary — are exactly the parts a fake would get wrong.
 */

const NOW = new Date("2026-07-20T12:00:00.000Z");

/**
 * `db.ts` memoizes its open handle on purpose — the ingest pass runs every
 * tick — so each test has to drop it, or it keeps writing to the previous
 * test's temp directory. `closeVault()` on both sides of the test is the whole
 * isolation story; re-importing the modules is not, because the cache lives in
 * the module they share rather than in the modules under test.
 */
async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), "argus-vault-"));
  const previous = process.env.ARGUS_CLAUDE_HOME;
  process.env.ARGUS_CLAUDE_HOME = home;
  closeVault();
  try {
    return await fn();
  } finally {
    closeVault();
    setVaultEngine(null);
    if (previous === undefined) delete process.env.ARGUS_CLAUDE_HOME;
    else process.env.ARGUS_CLAUDE_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "Triage the failing starling integration tests",
    cwd: "/tmp",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: "2026-07-20T11:50:00.000Z",
    startedAt: "2026-07-20T11:50:00.000Z",
    endedAt: "2026-07-20T11:55:00.000Z",
    durationMs: 300_000,
    pid: null,
    exitCode: 0,
    sessionId: "sess-1",
    project: "-home-u-proj",
    resultSummary: "Fixed the flaky retry assertion",
    error: null,
    costUsd: 0.2,
    tokens: 3000,
    ...over,
  };
}

const NO_SPEND = { days: {} };

function baseInput(runs: Run[], over: Partial<Record<string, unknown>> = {}) {
  return {
    runs,
    incidents: [] as Incident[],
    anomalies: [] as Anomaly[],
    verdicts: [] as Verdict[],
    spend: NO_SPEND,
    now: NOW,
    ...over,
  };
}

test("a fresh Vault opens, ingests and reports what it holds", async () => {
  await withHome(async () => {
    const result = ingest(baseInput([run()]));
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.runs, 1);

    const status = vaultStatus(["r1"]);
    assert.equal(status.available, true);
    assert.equal(status.rows.runs, 1);
    assert.equal(status.newestRunAt, "2026-07-20T11:55:00.000Z");
    assert.ok((status.sizeBytes ?? 0) > 0);
  });
});

test("ingest is idempotent: the same run twice is one row, updated in place", async () => {
  await withHome(async () => {
    ingest(baseInput([run({ status: "running", endedAt: null, resultSummary: null })]));
    ingest(baseInput([run({ status: "succeeded", resultSummary: "done at last" })]));

    const status = vaultStatus([]);
    assert.equal(status.rows.runs, 1);
    const hits = vaultSearch("last").hits;
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /done at last/);
  });
});

test("regression: a re-ingested run replaces its document rather than adding one", async () => {
  await withHome(async () => {
    ingest(baseInput([run({ resultSummary: "widget alpha" })]));
    ingest(baseInput([run({ resultSummary: "widget beta" })]));
    // FTS5 has no upsert. Without the explicit delete, "widget" would match the
    // same run twice and every search would grow by one row per completed pass.
    const hits = vaultSearch("widget").hits;
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /beta/);
  });
});

test("the Vault keeps runs the JSON files have pruned, and says how many", async () => {
  await withHome(async () => {
    ingest(baseInput([run({ id: "old-1" }), run({ id: "old-2" }), run({ id: "live-1" })]));
    // The JSON store has since pruned the two older records.
    const status = vaultStatus(["live-1"]);
    assert.equal(status.rows.runs, 3);
    assert.equal(status.beyondRetention, 2);
  });
});

test("incidents and anomalies become searchable events", async () => {
  await withHome(async () => {
    const incident: Incident = {
      id: "i1",
      key: "monitor:s1",
      source: "monitor-down",
      severity: "critical",
      title: "Nightly triage is down",
      detail: "no run in 26 hours",
      status: "open",
      openedAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      level: 0,
      nextEscalationAt: null,
      timeline: [
        {
          at: "2026-07-19T00:00:00.000Z",
          kind: "opened",
          detail: "monitor reported down",
          by: "sentinel",
        },
      ],
      diagnosis: null,
      scheduleId: "s1",
      runId: null,
      fingerprint: null,
    };
    const anomaly = {
      id: "s1|cost|r9",
      key: "schedule:s1",
      scope: "schedule",
      name: "Nightly triage",
      runId: "r9",
      scheduleId: "s1",
      metric: "cost",
      direction: "high",
      severity: "critical",
      value: 0.42,
      median: 0.13,
      ratio: 3.2,
      zScore: 8.1,
      at: "2026-07-20T09:00:00.000Z",
      detail: "3.2× median cost ($0.42 vs $0.13 over 24 runs)",
    } as Anomaly;

    ingest(baseInput([], { incidents: [incident], anomalies: [anomaly] }));

    const status = vaultStatus([]);
    assert.equal(status.rows.events, 2);
    const hits = vaultSearch("median").hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, "event");
    assert.equal(hits[0].href, "#/watchtower");
  });
});

test("regression: a capped incident timeline does not re-ingest on every prune", async () => {
  await withHome(async () => {
    const entries = [
      { at: "2026-07-19T00:00:00.000Z", kind: "opened", detail: "first", by: "sentinel" },
      { at: "2026-07-19T01:00:00.000Z", kind: "escalated", detail: "second", by: "sentinel" },
    ];
    const incident = (timeline: typeof entries): Incident =>
      ({
        id: "i1",
        key: "monitor:s1",
        source: "monitor-down",
        severity: "warning",
        title: "T",
        detail: "d",
        status: "open",
        openedAt: entries[0].at,
        updatedAt: entries[0].at,
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        level: 0,
        nextEscalationAt: null,
        timeline,
        diagnosis: null,
        scheduleId: "s1",
        runId: null,
        fingerprint: null,
      }) as Incident;

    ingest(baseInput([], { incidents: [incident(entries)] }));
    // The oldest entry ages out; every survivor shifts index. Content-hashed
    // ids must keep the surviving row identical rather than inserting a copy.
    ingest(baseInput([], { incidents: [incident(entries.slice(1))] }));
    assert.equal(vaultStatus([]).rows.events, 2);
  });
});

test("quarters aggregate runs, with medians that are absent rather than zero", async () => {
  await withHome(async () => {
    ingest(
      baseInput([
        run({
          id: "a",
          endedAt: "2026-02-10T10:00:00.000Z",
          startedAt: "2026-02-10T09:00:00.000Z",
        }),
        run({
          id: "b",
          endedAt: "2026-05-10T10:00:00.000Z",
          startedAt: "2026-05-10T09:30:00.000Z",
        }),
        run({
          id: "c",
          status: "failed",
          endedAt: "2026-05-11T10:00:00.000Z",
          startedAt: null,
          durationMs: null,
        }),
      ]),
    );
    const report = vaultQuarters();
    assert.equal(report.available, true);
    const q2 = report.quarters.find((q) => q.key === "2026-Q2")!;
    assert.equal(q2.runs, 2);
    assert.equal(q2.failed, 1);
    assert.equal(q2.medianDurationMs, 1_800_000);
    // Nothing was scored, so the median score is null — not zero, which would
    // read as "we measured, and it was terrible".
    assert.equal(q2.medianScore, null);
    assert.ok(report.quarters.some((q) => q.key === "2026-Q1"));
  });
});

test("verdict scores land in the quarter view, and unfinished ones do not", async () => {
  await withHome(async () => {
    const verdict = (over: Partial<Verdict>): Verdict =>
      ({
        runId: "a",
        scheduleId: "s1",
        scheduleName: "Nightly triage",
        phaseId: null,
        status: "ready",
        at: "2026-05-10T10:00:00.000Z",
        score: 8,
        criteria: [],
        summary: "solid",
        regression: false,
        minScore: 6,
        costUsd: null,
        tokens: null,
        durationMs: null,
        error: null,
        ...over,
      }) as Verdict;

    ingest(
      baseInput([run({ id: "a", endedAt: "2026-05-10T10:00:00.000Z" })], {
        verdicts: [verdict({}), verdict({ runId: "b", status: "failed", score: null })],
      }),
    );
    const q2 = vaultQuarters().quarters.find((q) => q.key === "2026-Q2")!;
    assert.equal(q2.medianScore, 8);
    assert.equal(vaultStatus([]).rows.scores, 1);
  });
});

test("search is prefix-matching and cannot be made to inject FTS operators", async () => {
  await withHome(async () => {
    ingest(baseInput([run({ prompt: "Triage the Starling integration suite" })]));

    assert.equal(vaultSearch("starl").hits.length, 1);

    // The quotes and the operator are stripped to bare terms, so this asks for
    // documents containing all of "starling", "or", "docs" and "match" — which
    // is nothing. Two things are being asserted: the expression did not reach
    // FTS5's grammar (an unescaped quote is a syntax error, which would show up
    // as a `search failed` detail), and it did not silently widen the query
    // into an OR that matches the whole index.
    const nasty = vaultSearch('starling" OR docs MATCH "');
    assert.equal(nasty.available, true);
    assert.doesNotMatch(nasty.detail, /search failed/);
    assert.equal(nasty.hits.length, 0);

    assert.equal(vaultSearch("   ").hits.length, 0);
  });
});

test("related terms come from the corpus and are labelled as related, never as direct", async () => {
  await withHome(async () => {
    ingest(
      baseInput([
        run({ id: "a", prompt: "retry backoff exhausted", resultSummary: "quarantine flaky" }),
        run({ id: "b", prompt: "retry backoff exhausted", resultSummary: "quarantine flaky" }),
        run({ id: "c", prompt: "quarantine the flaky suite", resultSummary: null }),
      ]),
    );
    const res = vaultSearch("backoff");
    assert.ok(res.relatedTerms.includes("quarantine"), res.relatedTerms.join(","));
    const related = res.hits.filter((h) => h.related);
    assert.ok(related.length >= 1);
    // Run "c" never mentions backoff; it is reachable only through the
    // expansion, and must arrive flagged so it cannot pass as a direct match.
    assert.ok(related.some((h) => h.ref === "c"));
    assert.ok(res.hits.filter((h) => !h.related).every((h) => h.ref !== "c"));
  });
});

test("a disabled Vault is a clean unavailable, not an error", async () => {
  await withHome(async () => {
    process.env.ARGUS_VAULT = "off";
    closeVault();
    try {
      const status = vaultStatus([]);
      assert.equal(status.available, false);
      assert.equal(status.reason, "disabled");
      assert.match(status.detail, /ARGUS_VAULT=off/);
      assert.equal(vaultQuarters().quarters.length, 0);
      assert.equal(vaultSearch("anything").hits.length, 0);
      assert.equal(runsBetween(0, Date.now()).length, 0);
      assert.equal(ingest(baseInput([run()])).ok, false);
    } finally {
      delete process.env.ARGUS_VAULT;
    }
  });
});

test("an engine that refuses to load degrades to unavailable, without throwing", async () => {
  await withHome(async () => {
    setVaultEngine(() => {
      throw new Error("Cannot find module 'node:sqlite'");
    });
    const status = vaultStatus([]);
    assert.equal(status.available, false);
    assert.equal(status.reason, "no-sqlite");
    assert.match(status.detail, /Node 22/);
  });
});

test("runsBetween windows the history for the long Chronicle", async () => {
  await withHome(async () => {
    ingest(
      baseInput([
        run({ id: "old", endedAt: "2025-01-01T00:00:00.000Z" }),
        run({ id: "new", endedAt: "2026-07-20T11:55:00.000Z" }),
      ]),
    );
    const rows = runsBetween(Date.parse("2026-01-01T00:00:00.000Z"), Date.now());
    assert.deepEqual(
      rows.map((r) => r.id),
      ["new"],
    );
  });
});

test("a monitor or budget transition is archived as it happens", async () => {
  await withHome(async () => {
    const { alertEvent, ingestAlert } = await import("./ingest.js");
    const event = alertEvent({
      kind: "monitor.down",
      at: NOW.toISOString(),
      severity: "warning",
      subject: "Nightly triage",
      detail: "no run in 26 hours",
      href: "#/monitors",
    })!;
    assert.equal(ingestAlert(event), true);

    assert.equal(vaultStatus([]).rows.events, 1);
    // Monitor and budget transitions are derived per tick and diffed in memory;
    // without this they are pushed to the bell and then gone, and nothing on
    // disk can answer "how often did this flap last quarter".
    const hits = vaultSearch("26 hours").hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].href, "#/monitors");
  });
});

test("regression: the same transition twice is one row", async () => {
  await withHome(async () => {
    const { alertEvent, ingestAlert } = await import("./ingest.js");
    const make = () =>
      alertEvent({
        kind: "budget.exceeded",
        at: NOW.toISOString(),
        severity: "critical",
        subject: "Budget",
        detail: "today $12.40 of $10.00",
        href: "#/budget",
      })!;
    ingestAlert(make());
    ingestAlert(make());
    // Content-hashed, so a restart that replays a tick cannot duplicate
    // history — and a search cannot report one breach as two.
    assert.equal(vaultStatus([]).rows.events, 1);
    assert.equal(vaultSearch("12.40").hits.length, 1);
  });
});

test("an alert with no usable timestamp is dropped, not stored at the epoch", async () => {
  await withHome(async () => {
    const { alertEvent } = await import("./ingest.js");
    assert.equal(
      alertEvent({
        kind: "monitor.down",
        at: "not a date",
        severity: "warning",
        subject: "x",
        detail: "y",
        href: "#/monitors",
      }),
      null,
    );
  });
});

test("archiving an alert while the Vault is off is a clean false, not a throw", async () => {
  await withHome(async () => {
    process.env.ARGUS_VAULT = "off";
    closeVault();
    try {
      const { alertEvent, ingestAlert } = await import("./ingest.js");
      const event = alertEvent({
        kind: "monitor.down",
        at: NOW.toISOString(),
        severity: "warning",
        subject: "x",
        detail: "y",
        href: "#/monitors",
      })!;
      // An alert that fails to archive must not break the alert.
      assert.equal(ingestAlert(event), false);
    } finally {
      delete process.env.ARGUS_VAULT;
    }
  });
});
