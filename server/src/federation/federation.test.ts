import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BudgetStatus, Incident, MachineSummary, MonitorHealth, Peer } from "@argus/contracts";
import type { Issue } from "../sources/issues.js";
import type { PipelineInstance } from "../sources/pipelineTypes.js";
import type { Run } from "../sources/scheduleTypes.js";
import {
  addPeer,
  machineIdentity,
  publicPeers,
  readPeers,
  removePeer,
  setLabel,
  validatePeer,
  PeerValidationError,
  type PeerHealth,
} from "./peers.js";
import { buildFacets, buildSummary, parseFacets, parseSummary } from "./summary.js";
import { buildFleet, fleetTotals } from "./fleet.js";
import { createPoller } from "./poll.js";
import { newSecret, pairingId, seal } from "./envelope.js";
import { assertPeersAreSafe, isLoopbackUrl } from "../config.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const SECRET = "a".repeat(64);

beforeEach(() => {
  process.env.ARGUS_CLAUDE_HOME = mkdtempSync(path.join(tmpdir(), "argus-fed-"));
});

// ── The peer store ──────────────────────────────────────────────────────────

test("a peer must have a label, an http(s) url and a real pairing secret", () => {
  assert.throws(
    () => validatePeer({ label: "", url: "http://a", secret: SECRET }),
    PeerValidationError,
  );
  assert.throws(
    () => validatePeer({ label: "Box", url: "file:///etc/passwd", secret: SECRET }),
    /http or https/,
  );
  assert.throws(() => validatePeer({ label: "Box", url: "not a url", secret: SECRET }), /absolute/);
  assert.throws(
    () => validatePeer({ label: "Box", url: "http://a", secret: "short" }),
    /pairing code/,
  );
});

test("a peer url is normalized so one machine is not two peers", async () => {
  const a = validatePeer({ label: "Box", url: "http://box.local:7777/", secret: SECRET });
  assert.equal(a.url, "http://box.local:7777");
  await addPeer({ label: "Box", url: "http://box.local:7777", secret: SECRET }, NOW);
  await assert.rejects(
    () => addPeer({ label: "Box again", url: "http://box.local:7777/", secret: SECRET }, NOW),
    /already paired/,
  );
});

test("peers round-trip, and removing one is reported", async () => {
  const peer = await addPeer({ label: "Build box", url: "http://box:7777", secret: SECRET }, NOW);
  assert.equal((await readPeers()).length, 1);
  assert.equal(await removePeer(peer.id), true);
  assert.equal(await removePeer(peer.id), false);
  assert.equal((await readPeers()).length, 0);
});

test("regression: a secret never leaves through the public shape", async () => {
  const peer = await addPeer({ label: "Build box", url: "http://box:7777", secret: SECRET }, NOW);
  const shown = publicPeers([{ ...peer }], new Map());
  // The one thing that must never be serialized to a client.
  assert.equal(JSON.stringify(shown).includes(SECRET), false);
  assert.equal("secret" in (shown[0] as unknown as Record<string, unknown>), false);
  assert.equal(shown[0].status, "pending");
});

test("machine identity is minted once and is not the hostname", async () => {
  const first = await machineIdentity("laptop");
  const second = await machineIdentity("something-else");
  assert.equal(first.machineId, second.machineId);
  // The id travels to every peer; a monitoring tool should not be why a machine
  // name ends up somewhere it was not before.
  assert.match(first.machineId, /^[0-9a-f-]{36}$/);
  assert.equal(second.label, "laptop", "the label is set once, not on every read");
  assert.equal(await setLabel("Build box"), "Build box");
  assert.equal((await machineIdentity("ignored")).label, "Build box");
});

// ── Refuse to boot ──────────────────────────────────────────────────────────

test("loopback is recognised; anything else is not", () => {
  for (const url of ["http://localhost:7777", "http://127.0.0.1:7777", "http://[::1]:7777"]) {
    assert.equal(isLoopbackUrl(url), true, url);
  }
  for (const url of ["http://box.local:7777", "https://argus.example.com", "nonsense"]) {
    assert.equal(isLoopbackUrl(url), false, url);
  }
});

test("regression: an unpaired remote peer refuses the boot", () => {
  // The check that makes the feature's security promise true rather than
  // aspirational: a peer over a real network with no secret is an
  // unauthenticated exchange in both directions.
  assert.throws(
    () => assertPeersAreSafe([{ label: "Build box", url: "http://box.local:7777", secret: "" }]),
    /refusing to start/,
  );
  // Paired remote and unpaired loopback are both fine.
  assertPeersAreSafe([
    { label: "Build box", url: "http://box.local:7777", secret: SECRET },
    { label: "Local test", url: "http://127.0.0.1:7778", secret: "" },
  ]);
  assertPeersAreSafe([]);
});

// ── The summary ─────────────────────────────────────────────────────────────

const monitor = (status: MonitorHealth["status"]): MonitorHealth =>
  ({
    scheduleId: "s",
    name: "n",
    enabled: true,
    status,
    heartbeats: [],
  }) as unknown as MonitorHealth;

const budget: BudgetStatus = {
  state: "ok",
  today: { spentUsd: 1.239, limitUsd: 10, ratio: 0.12 },
  month: { spentUsd: 40.5, limitUsd: null, ratio: null },
  blockScheduled: false,
};

function summaryInput(over: Record<string, unknown> = {}) {
  return {
    machineId: "m1",
    label: "Laptop",
    version: "0.4.0",
    schedules: 3,
    monitors: [monitor("down"), monitor("failing"), monitor("up")],
    issues: [{ state: "open" }, { state: "resolved" }] as Issue[],
    instances: [
      { status: "running" },
      { status: "awaiting-approval" },
      { status: "succeeded" },
    ] as PipelineInstance[],
    runs: [
      { endedAt: NOW.toISOString(), status: "succeeded" },
      { endedAt: NOW.toISOString(), status: "failed" },
      { endedAt: "2020-01-01T00:00:00.000Z", status: "failed" },
    ] as Run[],
    incidents: [] as Incident[],
    budget,
    now: NOW,
    ...over,
  };
}

test("a summary is counts and nothing identifying", () => {
  const s = buildSummary(summaryInput());
  assert.equal(s.monitorsDown, 1);
  assert.equal(s.monitorsFailing, 1);
  assert.equal(s.openIssues, 1);
  assert.equal(s.liveInstances, 1);
  assert.equal(s.gatedInstances, 1);
  assert.equal(s.runsToday, 2, "yesterday's run is not today's");
  assert.equal(s.failuresToday, 1);
  assert.equal(s.spendTodayUsd, 1.24);
  // A peer summary crosses a network. No prompts, no error text, no names of
  // anything the author of a run did not expect to travel.
  const text = JSON.stringify(s);
  assert.equal(/prompt|cwd|sessionId|error/.test(text), false);
});

test("the worst incident is the headline, and severity beats recency", () => {
  const incident = (severity: string, updatedAt: string, title: string) =>
    ({ severity, updatedAt, title, status: "open" }) as Incident;
  const s = buildSummary(
    summaryInput({
      incidents: [
        incident("warning", "2026-07-20T11:59:00.000Z", "Newer but milder"),
        incident("critical", "2026-07-20T09:00:00.000Z", "Older and worse"),
        incident("critical", "2026-07-20T08:00:00.000Z", "Oldest"),
      ],
    }),
  );
  assert.equal(s.worstIncident, "critical: Older and worse");
});

test("a resolved incident is not a headline", () => {
  const s = buildSummary(
    summaryInput({
      incidents: [
        { severity: "critical", updatedAt: NOW.toISOString(), title: "Fixed", status: "resolved" },
      ],
    }),
  );
  assert.equal(s.worstIncident, null);
});

test("regression: a summary off the wire is validated, not trusted", () => {
  assert.equal(parseSummary(null), null);
  assert.equal(parseSummary({ machineId: "" }), null);
  assert.equal(parseSummary({ machineId: "m", generatedAt: "not a date" }), null);

  const hostile = parseSummary({
    machineId: "m",
    generatedAt: NOW.toISOString(),
    label: "x".repeat(500),
    openIssues: -5,
    spendTodayUsd: "lots",
    worstIncident: "y".repeat(500),
  })!;
  // A peer names itself; it does not get to name itself in half a kilobyte, or
  // to send a negative count that would silently reduce a fleet total.
  assert.equal(hostile.label.length, 60);
  assert.equal(hostile.openIssues, 0);
  assert.equal(hostile.spendTodayUsd, 0);
  assert.equal(hostile.worstIncident!.length, 140);
});

// ── Facets: the detail the fleet-wide views read ────────────────────────────

test("facets carry labels for each fleet-wide view, and no payloads", () => {
  const f = buildFacets(
    summaryInput({
      instances: [
        {
          id: "i1",
          pipelineName: "Release train",
          status: "awaiting-approval",
          phases: [{ id: "review", status: "awaiting-approval" }],
        },
        { id: "i2", pipelineName: "Done one", status: "succeeded", phases: [] },
      ],
      issues: [
        { state: "open", fingerprint: "fp1", title: "Loud", count: 9, lastSeen: NOW.toISOString() },
        {
          state: "open",
          fingerprint: "fp2",
          title: "Quiet",
          count: 1,
          lastSeen: NOW.toISOString(),
        },
        {
          state: "resolved",
          fingerprint: "fp3",
          title: "Gone",
          count: 99,
          lastSeen: NOW.toISOString(),
        },
      ],
      runs: [
        {
          id: "r1",
          scheduleId: "s1",
          scheduleName: "Nightly triage",
          prompt: "SECRET PROMPT TEXT",
          cwd: "/home/me/private",
          sessionId: "sess-1",
          status: "succeeded",
          endedAt: NOW.toISOString(),
          durationMs: 1000,
        },
      ],
    }),
  );

  assert.deepEqual(
    f.pipelines.map((p) => [p.name, p.status, p.phase]),
    [["Release train", "awaiting-approval", "review"]],
    "only live pipelines, with the phase they are at",
  );
  // Loudest first: an arbitrary twelve would hide the ones worth crossing a
  // machine boundary for.
  assert.deepEqual(
    f.issues.map((i) => i.title),
    ["Loud", "Quiet"],
  );
  assert.equal(f.recentRuns[0].label, "Nightly triage");
  // The three fields that are certain to hold something written for one
  // machine's eyes never travel.
  const text = JSON.stringify(f);
  assert.equal(text.includes("SECRET PROMPT TEXT"), false);
  assert.equal(text.includes("/home/me/private"), false);
  assert.equal(text.includes("sess-1"), false);
  assert.equal(f.budget.dailyLimitUsd, 10);
});

test("facet lists are capped at the sender", () => {
  const many = (n: number, make: (i: number) => unknown) =>
    Array.from({ length: n }, (_, i) => make(i));
  const f = buildFacets(
    summaryInput({
      instances: many(50, (i) => ({
        id: `i${i}`,
        pipelineName: `P${i}`,
        status: "running",
        phases: [],
      })),
      issues: many(50, (i) => ({
        state: "open",
        fingerprint: `fp${i}`,
        title: `T${i}`,
        count: i,
        lastSeen: NOW.toISOString(),
      })),
      runs: many(100, (i) => ({
        id: `r${i}`,
        scheduleId: "s",
        scheduleName: "S",
        endedAt: NOW.toISOString(),
        status: "succeeded",
      })),
    }),
  );
  assert.equal(f.pipelines.length, 12);
  assert.equal(f.issues.length, 12);
  assert.equal(f.recentRuns.length, 40);
});

test("regression: the caps are re-applied to what a peer sends, not just to what we send", () => {
  const hostile = parseFacets({
    pipelines: Array.from({ length: 4000 }, (_, i) => ({ id: `i${i}`, name: "x".repeat(500) })),
    issues: Array.from({ length: 4000 }, (_, i) => ({ fingerprint: `f${i}`, count: -5 })),
    recentRuns: Array.from({ length: 4000 }, (_, i) => ({ id: `r${i}` })),
    budget: { state: "z".repeat(500), dailyLimitUsd: -3 },
  });
  // A peer is a machine you trust to be yours, not one you trust to be correct.
  // A bug or an older build on the other side must not render 4000 rows here.
  assert.equal(hostile.pipelines.length, 12);
  assert.equal(hostile.pipelines[0].name.length, 80);
  assert.equal(hostile.issues.length, 12);
  assert.equal(hostile.issues[0].count, 0, "a negative count would skew a total");
  assert.equal(hostile.recentRuns.length, 40);
  assert.equal(hostile.budget.state.length, 24);
  assert.equal(hostile.budget.dailyLimitUsd, null);
});

test("a summary with no facets at all parses to empty ones", () => {
  // An older peer, or one mid-upgrade: the views degrade to "nothing to show
  // from that machine" rather than throwing on `undefined.pipelines`.
  const parsed = parseSummary({ machineId: "m", generatedAt: NOW.toISOString() })!;
  assert.deepEqual(parsed.facets.pipelines, []);
  assert.equal(parsed.facets.budget.state, "unset");
});

// ── The fleet view ──────────────────────────────────────────────────────────

const machineSummary = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: "m1",
  label: "Laptop",
  version: "0.4.0",
  generatedAt: NOW.toISOString(),
  schedules: 2,
  monitorsDown: 1,
  monitorsFailing: 0,
  openIssues: 2,
  liveInstances: 1,
  gatedInstances: 0,
  runsToday: 5,
  failuresToday: 1,
  spendTodayUsd: 1.5,
  spendMonthUsd: 20,
  worstIncident: null,
  facets: {
    pipelines: [],
    issues: [],
    recentRuns: [],
    budget: { state: "ok", dailyLimitUsd: 10, monthlyLimitUsd: null },
  },
  ...over,
});

const peer = (over: Partial<Peer> = {}): Peer => ({
  id: "p1",
  label: "Build box",
  url: "http://box:7777",
  status: "paired",
  lastSeenAt: NOW.toISOString(),
  error: null,
  addedAt: NOW.toISOString(),
  ...over,
});

test("solo mode is the zero-config default", () => {
  const view = buildFleet(machineSummary(), [], new Map(), NOW);
  assert.equal(view.soloMode, true);
  assert.equal(view.machines.length, 1);
  assert.equal(view.machines[0].isSelf, true);
});

test("self comes first, then peers", () => {
  const view = buildFleet(
    machineSummary(),
    [peer({ id: "p2", label: "Zeta" }), peer({ id: "p1", label: "Alpha" })],
    new Map(),
    NOW,
  );
  assert.deepEqual(
    view.machines.map((m) => m.peer.label),
    ["Laptop", "Zeta", "Alpha"],
  );
  assert.equal(view.soloMode, false);
});

test("regression: totals say how many machines they are made of", () => {
  const view = buildFleet(
    machineSummary(),
    [peer({ id: "p1" }), peer({ id: "p2", label: "Quiet one", status: "unreachable" })],
    new Map([["p1", machineSummary({ machineId: "m2", openIssues: 3, spendTodayUsd: 2.25 })]]),
    NOW,
  );
  assert.equal(view.totals.machines, 3);
  // Silently summing whatever is reachable is how "spend is fine" becomes wrong
  // on the day a machine goes quiet — which is the day it matters.
  assert.equal(view.totals.reporting, 2);
  assert.equal(view.totals.openIssues, 5);
  assert.equal(view.totals.spendTodayUsd, 3.75);
});

test("a stale peer keeps its last summary rather than blanking", () => {
  const view = buildFleet(
    machineSummary(),
    [peer({ status: "stale", lastSeenAt: "2026-07-20T11:00:00.000Z" })],
    new Map([["p1", machineSummary({ machineId: "m2" })]]),
    NOW,
  );
  // "Last known, an hour ago" is information; an empty card is not.
  assert.ok(view.machines[1].summary);
  assert.equal(view.machines[1].peer.status, "stale");
});

test("totals of nothing are zeroes, not NaN", () => {
  const totals = fleetTotals([]);
  assert.equal(totals.machines, 0);
  assert.equal(totals.reporting, 0);
  assert.equal(totals.spendTodayUsd, 0);
});

// ── The poller ──────────────────────────────────────────────────────────────

function pollDeps(
  fetchImpl: typeof globalThis.fetch,
  peers = [
    {
      id: "p1",
      label: "Build box",
      url: "http://box:7777",
      secret: SECRET,
      addedAt: NOW.toISOString(),
    },
  ],
) {
  return {
    now: () => NOW,
    readPeers: async () => peers,
    fetch: fetchImpl,
  };
}

function sealedResponse(summary: MachineSummary, secret = SECRET, at = NOW) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(seal(summary, secret, summary.machineId, at)),
  } as Response;
}

test("a verified peer summary lands, and the request names the pairing", async () => {
  let seenHeader = "";
  const poller = createPoller(
    pollDeps(async (_url, init) => {
      seenHeader = ((init?.headers ?? {}) as Record<string, string>)["x-argus-pairing"];
      return sealedResponse(machineSummary({ machineId: "m2", label: "Build box" }));
    }),
  );
  await poller.check();
  // Derived from the shared secret, so both machines name the pairing the same
  // way without either sending the secret.
  assert.equal(seenHeader, pairingId(SECRET));
  const { summaries, health } = poller.state();
  assert.equal(summaries.get("p1")?.label, "Build box");
  assert.equal(health.get("p1")?.status, "paired");
});

test("regression: a summary sealed with the wrong secret is unauthorized, not accepted", async () => {
  const poller = createPoller(
    pollDeps(async () => sealedResponse(machineSummary({ machineId: "evil" }), newSecret())),
  );
  await poller.check();
  assert.equal(poller.state().summaries.has("p1"), false);
  assert.equal(poller.state().health.get("p1")?.status, "unauthorized");
});

test("a 401 reads as unauthorized, and a 500 as unreachable", async () => {
  for (const [status, expected] of [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [500, "unreachable"],
  ] as const) {
    const poller = createPoller(pollDeps(async () => ({ ok: false, status }) as Response));
    await poller.check();
    // A mismatched secret and a broken peer are different problems and want
    // different fixes, so they are not both "down".
    assert.equal(poller.state().health.get("p1")?.status, expected, String(status));
  }
});

test("a peer that throws is unreachable, with the reason kept", async () => {
  const poller = createPoller(
    pollDeps(async () => {
      throw new Error("ECONNREFUSED");
    }),
  );
  await poller.check();
  assert.equal(poller.state().health.get("p1")?.status, "unreachable");
  assert.match(poller.state().health.get("p1")!.error!, /ECONNREFUSED/);
});

test("an oversized response is refused before it is parsed", async () => {
  const poller = createPoller(
    pollDeps(
      async () => ({ ok: true, status: 200, text: async () => "x".repeat(200_000) }) as Response,
    ),
  );
  await poller.check();
  assert.match(poller.state().health.get("p1")!.error!, /more than a summary/);
});

test("regression: state for a removed peer does not linger in the fleet", async () => {
  let peers = [
    { id: "p1", label: "Box", url: "http://box:7777", secret: SECRET, addedAt: NOW.toISOString() },
  ];
  const poller = createPoller({
    now: () => NOW,
    readPeers: async () => peers,
    fetch: async () => sealedResponse(machineSummary({ machineId: "m2" })),
  });
  await poller.check();
  assert.equal(poller.state().summaries.size, 1);
  peers = [];
  await poller.check();
  // An unpaired machine must not keep appearing in the fleet view.
  assert.equal(poller.state().summaries.size, 0);
  assert.equal(poller.state().health.size, 0);
});

test("nothing is fetched when there are no peers", async () => {
  let calls = 0;
  const poller = createPoller({
    now: () => NOW,
    readPeers: async () => [],
    fetch: async () => {
      calls++;
      return sealedResponse(machineSummary());
    },
  });
  await poller.check();
  // Single-machine zero-config: with no peers, federation costs nothing.
  assert.equal(calls, 0);
});

test("a peer that answered once decays to stale rather than staying green", async () => {
  const later = new Date(NOW.getTime() + 10 * 60_000);
  let now = NOW;
  const poller = createPoller({
    now: () => now,
    readPeers: async () => [
      {
        id: "p1",
        label: "Box",
        url: "http://box:7777",
        secret: SECRET,
        addedAt: NOW.toISOString(),
      },
    ],
    fetch: async () => sealedResponse(machineSummary({ machineId: "m2" }), SECRET, now),
  });
  await poller.check();
  assert.equal(poller.state().health.get("p1")?.status, "paired");

  now = later;
  const failing = createPoller({
    now: () => now,
    readPeers: async () => [
      {
        id: "p1",
        label: "Box",
        url: "http://box:7777",
        secret: SECRET,
        addedAt: NOW.toISOString(),
      },
    ],
    fetch: async () => {
      throw new Error("gone");
    },
  });
  // Seed the health map with an old success, then fail: the peer keeps its last
  // summary and reads as stale rather than blanking on one dropped packet.
  failing.state().health.set("p1", {
    status: "paired",
    lastSeenAt: NOW.toISOString(),
    error: null,
  } as PeerHealth);
  await failing.check();
  assert.equal(failing.state().health.get("p1")?.status, "stale");
});

test("a read failure on the peer list is survived, not thrown", async () => {
  const poller = createPoller({
    now: () => NOW,
    readPeers: async () => {
      throw new Error("disk gone");
    },
    fetch: async () => sealedResponse(machineSummary()),
  });
  await poller.check();
  assert.equal(poller.state().summaries.size, 0);
});
