import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../app.js";
import type { ArgusConfig } from "../config.js";
import type { Engine } from "../pipelineEngine.js";
import { createAuthService, type AuthService } from "../auth.js";
import { createUserStore } from "../userStore.js";
import type { ClaimDetail, ClaimView, DependentsReport, SupportReport } from "@argus/contracts";

/**
 * The `/api/knowledge` contract: auth posture, validation at the boundary,
 * and the read surface over a graph built through the same API. The semantics
 * themselves are proven in kernel.test.ts; this file proves the HTTP layer
 * neither adds to nor subtracts from them.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-knowledge-api-"));
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

const fakeEngine: Engine = {
  start: async () => null,
  onSignal: async () => ({ ok: true, code: 200 }),
  approve: async () => ({ ok: true, code: 200 }),
  revise: async () => ({ ok: true, code: 200 }),
  abort: async () => ({ ok: true, code: 200 }),
  reconcile: async () => {},
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

function makeApp(auth: AuthService = openAuth) {
  return createApp({
    config,
    engine: fakeEngine,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth,
  });
}

const loopback = { host: "localhost:7777" };
const sameOrigin = {
  host: "localhost:7777",
  origin: "http://localhost:7777",
  "content-type": "application/json",
};

type App = ReturnType<typeof makeApp>;

async function post(app: App, url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
async function get(app: App, url: string) {
  const res = await app.request(url, { headers: loopback });
  return { status: res.status, body: (await res.json()) as any };
}

/** FACT + RULE → CONCLUSION → DECISION, grounded on human evidence. */
async function seedExample(app: App) {
  for (const c of [
    { id: "FACT-12", kind: "fact", statement: "Kobra exposes a free-text comment field" },
    { id: "RULE-7", kind: "business-rule", statement: "Kobra comment maximum is 180" },
    { id: "CONCLUSION-19", kind: "conclusion", statement: "Validate comments at 180 chars" },
    { id: "DECISION-21", kind: "decision", statement: "Ship the 180-char validator" },
  ]) {
    const r = await post(app, "/api/knowledge/claims", c);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  for (const claim of ["FACT-12", "RULE-7"]) {
    const r = await post(app, "/api/knowledge/evidence", {
      claim,
      direction: "supports",
      source: { type: "human", who: "product owner" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const j1 = await post(app, "/api/knowledge/justifications", {
    conclusion: "CONCLUSION-19",
    premises: ["FACT-12", "RULE-7"],
    producedBy: { instanceId: "inst-1", phaseId: "plan", runId: "run-9" },
  });
  assert.equal(j1.status, 201, JSON.stringify(j1.body));
  const j2 = await post(app, "/api/knowledge/justifications", {
    conclusion: "DECISION-21",
    premises: ["CONCLUSION-19"],
  });
  assert.equal(j2.status, 201, JSON.stringify(j2.body));
  return { j1: j1.body, j2: j2.body };
}

// ── Auth posture ────────────────────────────────────────────────────────────

test("mutations are admin-gated; reads stay open", async () => {
  const app = makeApp(createAuthService({ store: createUserStore() }));
  for (const url of [
    "/api/knowledge/claims",
    "/api/knowledge/claims/X/revise",
    "/api/knowledge/evidence",
    "/api/knowledge/justifications",
  ]) {
    const r = await post(app, url, {});
    assert.equal(r.status, 401, url);
    assert.equal(r.body.code, "auth_setup_required", url);
  }
  const list = await get(app, "/api/knowledge/claims");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, { claims: [] });
});

// ── Validation at the boundary ──────────────────────────────────────────────

test("proposals are validated field by field; nothing invalid is written", async () => {
  const app = makeApp();
  const cases: Array<[string, unknown, RegExp]> = [
    ["/api/knowledge/claims", { kind: "fact" }, /statement/],
    ["/api/knowledge/claims", { kind: "opinion", statement: "x" }, /kind must be one of/],
    [
      "/api/knowledge/claims",
      { kind: "fact", statement: "x", id: "no spaces" },
      /id is not a valid/,
    ],
    [
      "/api/knowledge/claims",
      { kind: "fact", statement: "x", producedBy: { runId: "a b" } },
      /producedBy.runId/,
    ],
    ["/api/knowledge/claims", { kind: "fact", statement: "x".repeat(8001) }, /exceeds/],
    ["/api/knowledge/claims", [], /must be an object/],
    [
      "/api/knowledge/evidence",
      { claim: "X", direction: "supports", source: { type: "human", who: "me" } },
      /unknown claim X/,
    ],
    [
      "/api/knowledge/evidence",
      { claim: "X", direction: "maybe", source: { type: "human", who: "me" } },
      /direction/,
    ],
    [
      "/api/knowledge/evidence",
      { claim: "X", source: { type: "telepathy" } },
      /source.type must be one of/,
    ],
    [
      "/api/knowledge/evidence",
      { claim: "X", source: { type: "git-commit", sha: "not-hex" } },
      /sha/,
    ],
    [
      "/api/knowledge/evidence",
      { claim: "X", source: { type: "source-code", path: "a.ts", line: 0 } },
      /line/,
    ],
    ["/api/knowledge/justifications", { conclusion: "X", premises: [] }, /at least one/],
    [
      "/api/knowledge/justifications",
      { conclusion: "X", premises: "FACT" },
      /premises must be an array/,
    ],
    ["/api/knowledge/justifications", { conclusion: "X", premises: ["FACT"] }, /unknown claim X/],
    [
      "/api/knowledge/justifications",
      { conclusion: { id: "X", revision: 0 }, premises: ["F"] },
      /revision must be a positive integer/,
    ],
  ];
  for (const [url, body, re] of cases) {
    const r = await post(app, url, body);
    assert.equal(r.status, 400, `${url} ${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.error), re, url);
  }
  const bad = await app.request("/api/knowledge/claims", {
    method: "POST",
    headers: sameOrigin,
    body: "{ nope",
  });
  assert.equal(bad.status, 400);
  const list = await get(app, "/api/knowledge/claims");
  assert.deepEqual(list.body, { claims: [] });
});

test("a justification referencing an unknown revision, or forming a cycle, is refused", async () => {
  const app = makeApp();
  await seedExample(app);
  const ghost = await post(app, "/api/knowledge/justifications", {
    conclusion: "CONCLUSION-19",
    premises: ["RULE-7:v2"],
  });
  assert.equal(ghost.status, 400);
  assert.match(ghost.body.error, /unknown claim RULE-7:v2/);

  const cycle = await post(app, "/api/knowledge/justifications", {
    conclusion: "FACT-12",
    premises: ["DECISION-21"],
  });
  assert.equal(cycle.status, 400);
  assert.match(cycle.body.error, /would form a cycle/);
});

test("revise refuses a revision key and 404s an unknown id", async () => {
  const app = makeApp();
  await seedExample(app);
  const keyed = await post(app, "/api/knowledge/claims/RULE-7:v1/revise", { statement: "x" });
  assert.equal(keyed.status, 400);
  const missing = await post(app, "/api/knowledge/claims/NOPE/revise", { statement: "x" });
  assert.equal(missing.status, 404);
});

// ── The worked example, end to end ──────────────────────────────────────────

test("FACT + RULE → CONCLUSION → DECISION, then the rule is superseded", async () => {
  const app = makeApp();
  const { j1 } = await seedExample(app);

  // Everything is supported while RULE-7:v1 is active and grounded.
  const decision = await get(app, "/api/knowledge/claims/DECISION-21");
  assert.equal(decision.status, 200);
  const detail = decision.body as ClaimDetail;
  assert.equal(detail.claim.support, "supported");
  assert.equal(detail.claim.lifecycle, "active");
  assert.equal(detail.revisions.length, 1);

  const support = (await get(app, "/api/knowledge/claims/CONCLUSION-19/support"))
    .body as SupportReport;
  assert.equal(support.support, "supported");
  assert.equal(support.justifications[0].justification.id, j1.id);
  assert.deepEqual(support.justifications[0].force, { inForce: true });
  assert.deepEqual(support.justifications[0].justification.producedBy, {
    instanceId: "inst-1",
    phaseId: "plan",
    runId: "run-9",
  });

  // What would lose support if the rule changed?
  const deps = (await get(app, "/api/knowledge/claims/RULE-7/dependents")).body as DependentsReport;
  assert.deepEqual(deps.claim, { id: "RULE-7", revision: 1 });
  assert.deepEqual(deps.direct, [{ id: "CONCLUSION-19", revision: 1 }]);
  assert.deepEqual(deps.transitive, [
    { id: "CONCLUSION-19", revision: 1 },
    { id: "DECISION-21", revision: 1 },
  ]);

  // The rule changes.
  const revised = await post(app, "/api/knowledge/claims/RULE-7/revise", {
    statement: "Kobra comment maximum is 500",
    revisionNote: "Kobra 4.2 raised the limit",
  });
  assert.equal(revised.status, 201, JSON.stringify(revised.body));
  const v2 = revised.body as ClaimView;
  assert.equal(v2.revision, 2);
  assert.equal(v2.lifecycle, "active");
  assert.equal(v2.kind, "business-rule");
  assert.equal(v2.support, "unsupported"); // no evidence has been attached to v2 yet

  // Bare id → the active revision; the history lists both, oldest first.
  const rule = (await get(app, "/api/knowledge/claims/RULE-7")).body as ClaimDetail;
  assert.equal(rule.claim.revision, 2);
  assert.deepEqual(
    rule.revisions.map((r) => [r.revision, r.lifecycle, r.statement]),
    [
      [1, "superseded", "Kobra comment maximum is 180"],
      [2, "active", "Kobra comment maximum is 500"],
    ],
  );
  assert.deepEqual(rule.revisions[0].supersededBy, { id: "RULE-7", revision: 2 });

  // v1 is still addressable, still supported on its own evidence.
  const old = (await get(app, "/api/knowledge/claims/RULE-7:v1")).body as ClaimDetail;
  assert.equal(old.claim.revision, 1);
  assert.equal(old.claim.lifecycle, "superseded");
  assert.equal(old.claim.support, "supported");

  // The justification still names v1 and is out of force because of it, and
  // that propagates: CONCLUSION-19 and DECISION-21 are unsupported.
  const after = (await get(app, "/api/knowledge/claims/CONCLUSION-19/support"))
    .body as SupportReport;
  assert.equal(after.support, "unsupported");
  assert.deepEqual(after.justifications[0].justification.premises, [
    { id: "FACT-12", revision: 1 },
    { id: "RULE-7", revision: 1 },
  ]);
  assert.deepEqual(after.justifications[0].force, {
    inForce: false,
    failing: [{ premise: { id: "RULE-7", revision: 1 }, reason: "superseded" }],
  });
  assert.equal(
    (await get(app, "/api/knowledge/claims/DECISION-21")).body.claim.support,
    "unsupported",
  );

  // Dependents are per revision: v2 has none until something is derived from it.
  assert.deepEqual((await get(app, "/api/knowledge/claims/RULE-7/dependents")).body.direct, []);
  assert.deepEqual((await get(app, "/api/knowledge/claims/RULE-7:v1/dependents")).body.direct, [
    { id: "CONCLUSION-19", revision: 1 },
  ]);

  // Re-deriving from v2 restores the conclusion through a *new* justification;
  // the old one is untouched.
  await post(app, "/api/knowledge/evidence", {
    claim: "RULE-7",
    source: { type: "document", uri: "https://kobra.example/release-notes/4.2" },
  });
  const j3 = await post(app, "/api/knowledge/justifications", {
    conclusion: "CONCLUSION-19",
    premises: ["FACT-12", "RULE-7"],
  });
  assert.equal(j3.status, 201);
  assert.deepEqual(j3.body.premises[1], { id: "RULE-7", revision: 2 });
  const restored = (await get(app, "/api/knowledge/claims/CONCLUSION-19/support"))
    .body as SupportReport;
  assert.equal(restored.support, "supported");
  assert.equal(restored.justifications.length, 2);
  assert.equal(restored.justifications[0].force.inForce, false);
  assert.equal(restored.justifications[1].force.inForce, true);
});

test("contested state is visible through the API", async () => {
  const app = makeApp();
  await seedExample(app);
  await post(app, "/api/knowledge/claims", {
    id: "AUDIT-1",
    kind: "fact",
    statement: "Audit found 220-char comments",
  });
  await post(app, "/api/knowledge/evidence", {
    claim: "AUDIT-1",
    source: { type: "run", runId: "run-audit" },
  });
  const r = await post(app, "/api/knowledge/justifications", {
    conclusion: "CONCLUSION-19",
    premises: ["AUDIT-1"],
    direction: "opposes",
  });
  assert.equal(r.status, 201);
  assert.equal(
    (await get(app, "/api/knowledge/claims/CONCLUSION-19")).body.claim.support,
    "contested",
  );
});

// ── Listing and lookups ─────────────────────────────────────────────────────

test("the list carries derived state and filters by kind and lifecycle", async () => {
  const app = makeApp();
  await seedExample(app);
  await post(app, "/api/knowledge/claims/RULE-7/revise", { statement: "500" });

  const all = (await get(app, "/api/knowledge/claims")).body.claims as ClaimView[];
  assert.equal(all.length, 5);
  assert.ok(all.every((c) => ["active", "superseded"].includes(c.lifecycle)));
  assert.ok(all.every((c) => ["supported", "unsupported", "contested"].includes(c.support)));

  const rules = (await get(app, "/api/knowledge/claims?kind=business-rule")).body
    .claims as ClaimView[];
  assert.deepEqual(
    rules.map((c) => c.revision),
    [1, 2],
  );
  const active = (await get(app, "/api/knowledge/claims?kind=business-rule&lifecycle=active")).body
    .claims;
  assert.deepEqual(
    active.map((c: ClaimView) => c.revision),
    [2],
  );
  assert.equal((await get(app, "/api/knowledge/claims?kind=nope")).status, 400);
  assert.equal((await get(app, "/api/knowledge/claims?lifecycle=dead")).status, 400);
});

test("unknown or malformed keys are 404 on every read", async () => {
  const app = makeApp();
  await seedExample(app);
  for (const key of ["NOPE", "RULE-7:v9", "RULE-7:2", "..%2F..%2Fetc", "a%20b"]) {
    for (const suffix of ["", "/support", "/dependents"]) {
      const r = await get(app, `/api/knowledge/claims/${key}${suffix}`);
      assert.equal(r.status, 404, `${key}${suffix}`);
    }
  }
});

test("the persisted document is the source of truth the API reads", async () => {
  const app = makeApp();
  await seedExample(app);
  // A second app instance over the same home sees the same graph — nothing is
  // held in process memory.
  const again = makeApp();
  const r = await get(again, "/api/knowledge/claims/DECISION-21/support");
  assert.equal(r.status, 200);
  assert.equal(r.body.support, "supported");
});
