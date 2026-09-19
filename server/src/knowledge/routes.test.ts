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
import type {
  ClaimDetail,
  ClaimView,
  ConsumersReport,
  DependentsReport,
  ExecutionContextReport,
  ExecutionProvenance,
  ImpactSet,
  SuppliedToReport,
  SupportReport,
} from "@argus/contracts";

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
    "/api/knowledge/executions/run-1/consumptions",
    "/api/knowledge/executions/run-1/artifacts",
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
    ["/api/knowledge/executions/run-1/consumptions", {}, /claims must be an array/],
    ["/api/knowledge/executions/run-1/consumptions", { claims: [] }, /at least one/],
    ["/api/knowledge/executions/run-1/consumptions", { claims: ["X"] }, /unknown claim X/],
    [
      "/api/knowledge/executions/run-1/consumptions",
      { claims: ["no spaces"] },
      /not a valid claim reference/,
    ],
    [
      "/api/knowledge/executions/run-1/consumptions",
      { claims: ["X"], instanceId: "a b" },
      /instanceId/,
    ],
    ["/api/knowledge/executions/run%201/consumptions", { claims: ["X"] }, /runId/],
    ["/api/knowledge/executions/run-1/artifacts", { artifacts: [] }, /at least one/],
    [
      "/api/knowledge/executions/run-1/artifacts",
      { artifacts: [{ location: "bucket", path: "x" }] },
      /location must be/,
    ],
    [
      "/api/knowledge/executions/run-1/artifacts",
      { artifacts: [{ location: "repository", path: "../etc/passwd" }] },
      /relative POSIX path/,
    ],
    [
      "/api/knowledge/executions/run-1/artifacts",
      { artifacts: [{ location: "repository", path: "/abs" }] },
      /relative POSIX path/,
    ],
    [
      "/api/knowledge/executions/run-1/artifacts",
      { artifacts: [{ location: "artifact-dir", path: "x", gitHead: "abc1234" }] },
      /only applies to a repository/,
    ],
    [
      "/api/knowledge/executions/run-1/artifacts",
      { artifacts: [{ location: "repository", path: "x", gitHead: "zz" }] },
      /hex commit sha/,
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
  assert.equal((await get(app, "/api/knowledge/executions/run-1/provenance")).status, 404);
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

// ── Execution provenance and impact, end to end ─────────────────────────────

test("a superseded rule → conclusion → decision → consumer run → artifact, through the API", async () => {
  const app = makeApp();
  await seedExample(app);

  // run-9 (the plan phase) derived CONCLUSION-19 — that is `producedBy` on J-1.
  // run-42 (the implement phase) consumed the decision and the conclusion and
  // wrote the validator. Two different facts, two different runs.
  const reg = await post(app, "/api/knowledge/executions/run-42/consumptions", {
    instanceId: "inst-1",
    phaseId: "implement",
    claims: ["DECISION-21", { id: "CONCLUSION-19", revision: 1 }],
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.deepEqual(reg.body.execution, {
    runId: "run-42",
    instanceId: "inst-1",
    phaseId: "implement",
  });
  assert.deepEqual(
    reg.body.consumptions.map((c: any) => c.claim),
    [
      { id: "DECISION-21", revision: 1 },
      { id: "CONCLUSION-19", revision: 1 },
    ],
  );
  // Registering the same pair again is a 200 no-op, and locators must agree.
  const again = await post(app, "/api/knowledge/executions/run-42/consumptions", {
    claims: ["DECISION-21:v1"],
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.consumptions[0].createdAt, reg.body.consumptions[0].createdAt);
  const conflict = await post(app, "/api/knowledge/executions/run-42/consumptions", {
    phaseId: "verify",
    claims: ["DECISION-21"],
  });
  assert.equal(conflict.status, 400);
  assert.match(conflict.body.error, /already recorded with phaseId "implement"/);

  const art = await post(app, "/api/knowledge/executions/run-42/artifacts", {
    artifacts: [
      { location: "repository", path: "src/CustomerCommentValidator.cs", gitHead: "abc1234" },
    ],
  });
  assert.equal(art.status, 201, JSON.stringify(art.body));
  assert.deepEqual(art.body.execution, {
    runId: "run-42",
    instanceId: "inst-1",
    phaseId: "implement",
  });
  assert.equal(
    (
      await post(app, "/api/knowledge/executions/run-42/artifacts", {
        artifacts: art.body.artifacts.map((a: any) => a.artifact),
      })
    ).status,
    200,
  );

  // An unrelated run in the same instance and phase.
  await post(app, "/api/knowledge/claims", { id: "OTHER", kind: "fact", statement: "o" });
  await post(app, "/api/knowledge/evidence", {
    claim: "OTHER",
    source: { type: "human", who: "me" },
  });
  await post(app, "/api/knowledge/executions/run-77/consumptions", {
    instanceId: "inst-1",
    phaseId: "implement",
    claims: ["OTHER"],
  });

  // Consumers are per exact revision; provenance is two-directional.
  const consumers = (await get(app, "/api/knowledge/claims/DECISION-21/consumers"))
    .body as ConsumersReport;
  assert.deepEqual(consumers.claim, { id: "DECISION-21", revision: 1 });
  assert.deepEqual(
    consumers.consumptions.map((c) => c.execution.runId),
    ["run-42"],
  );
  const consumer = (await get(app, "/api/knowledge/executions/run-42/provenance"))
    .body as ExecutionProvenance;
  assert.equal(consumer.currency, "current");
  assert.deepEqual(
    consumer.consumed.map((c) => [c.claim.id, c.current]),
    [
      ["DECISION-21", true],
      ["CONCLUSION-19", true],
    ],
  );
  assert.deepEqual(consumer.produced.artifacts, [
    { location: "repository", path: "src/CustomerCommentValidator.cs", gitHead: "abc1234" },
  ]);
  const producer = (await get(app, "/api/knowledge/executions/run-9/provenance"))
    .body as ExecutionProvenance;
  assert.deepEqual(producer.consumed, []);
  assert.deepEqual(
    producer.produced.justifications.map((j) => j.conclusion.id),
    ["CONCLUSION-19"],
  );

  // Nothing is impacted while the rule is current.
  const calm = (await get(app, "/api/knowledge/claims/RULE-7/impact")).body as ImpactSet;
  assert.deepEqual(calm.root.conditions, []);
  assert.deepEqual(calm.executions, []);

  // The rule changes.
  const revised = await post(app, "/api/knowledge/claims/RULE-7/revise", {
    statement: "Kobra comment maximum is 500",
    revisionNote: "Kobra 4.2 raised the limit",
  });
  assert.equal(revised.status, 201);

  const set = (await get(app, "/api/knowledge/claims/RULE-7:v1/impact")).body as ImpactSet;
  assert.deepEqual(set.root, {
    claim: { id: "RULE-7", revision: 1 },
    lifecycle: "superseded",
    support: "supported",
    conditions: ["superseded"],
  });
  assert.deepEqual(
    set.semantic.affectedClaims.map((c) => [
      `${c.claim.id}:v${c.claim.revision}`,
      c.reasons,
      c.support,
    ]),
    [
      [
        "CONCLUSION-19:v1",
        ["premise-superseded"],
        { ifRootHeld: "supported", actual: "unsupported" },
      ],
      [
        "DECISION-21:v1",
        ["premise-unsupported"],
        { ifRootHeld: "supported", actual: "unsupported" },
      ],
    ],
  );
  assert.deepEqual(set.executions, [
    {
      execution: { runId: "run-42", instanceId: "inst-1", phaseId: "implement" },
      reasons: ["consumed-affected-claim"],
      consumed: [
        { id: "DECISION-21", revision: 1 },
        { id: "CONCLUSION-19", revision: 1 },
      ],
    },
  ]);
  assert.deepEqual(
    set.artifacts.map((a) => [a.execution.runId, a.artifact.path, a.reasons]),
    [["run-42", "src/CustomerCommentValidator.cs", ["produced-by-affected-execution"]]],
  );
  // The producer run and the unrelated run are absent.
  const runs = JSON.stringify(set.executions) + JSON.stringify(set.artifacts);
  assert.ok(!runs.includes("run-9") && !runs.includes("run-77"));
  // The artifact's explanation runs the whole way from the rule.
  const artifactPath = set.paths.find((p) => p.target.kind === "artifact")!;
  assert.deepEqual(
    artifactPath.hops.map((h) => h.via),
    ["premise-of", "consumed-by", "produced"],
  );
  assert.deepEqual(artifactPath.hops[0].to, {
    kind: "claim",
    claim: { id: "CONCLUSION-19", revision: 1 },
  });
  assert.equal(artifactPath.hops[0].justification, producer.produced.justifications[0].id);

  // The run's own provenance now says stale — nothing about the run was rewritten.
  const later = (await get(app, "/api/knowledge/executions/run-42/provenance"))
    .body as ExecutionProvenance;
  assert.equal(later.currency, "stale");
  assert.deepEqual(
    later.consumed.map((c) => [c.claim.id, c.lifecycle, c.support, c.current]),
    [
      ["DECISION-21", "active", "unsupported", false],
      ["CONCLUSION-19", "active", "unsupported", false],
    ],
  );
  // The bare id resolves to v2, which nothing consumed and nothing depends on.
  const v2 = (await get(app, "/api/knowledge/claims/RULE-7/impact")).body as ImpactSet;
  assert.equal(v2.root.claim.revision, 2);
  assert.deepEqual(v2.root.conditions, ["unsupported"]);
  assert.deepEqual(v2.executions, []);
  assert.deepEqual(
    (await get(app, "/api/knowledge/claims/RULE-7/consumers")).body.consumptions,
    [],
  );

  // A second app over the same home reproduces the impact set exactly.
  const other = (await get(makeApp(), "/api/knowledge/claims/RULE-7:v1/impact")).body;
  assert.deepEqual(other, set);
});

test("provenance reads 404 on unknown or malformed keys", async () => {
  const app = makeApp();
  await seedExample(app);
  for (const key of ["NOPE", "RULE-7:v9", "a%20b"]) {
    for (const suffix of ["/consumers", "/impact"]) {
      assert.equal((await get(app, `/api/knowledge/claims/${key}${suffix}`)).status, 404);
    }
  }
  for (const run of ["unknown", "a%20b", "..%2F.."]) {
    assert.equal((await get(app, `/api/knowledge/executions/${run}/provenance`)).status, 404);
  }
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

// ── KnowledgeDeltas (Phase 3): inspection only ──────────────────────────────

test("delta inspection: 404 for unknown ids and empty lists for runs that staged nothing", async () => {
  const app = makeApp();
  assert.equal((await get(app, "/api/knowledge/deltas/KD-nope")).status, 404);
  assert.equal((await get(app, "/api/knowledge/deltas/KD-nope/result")).status, 404);
  assert.equal((await get(app, "/api/knowledge/deltas/..%2Fx")).status, 404);
  const r = await get(app, "/api/knowledge/executions/run-none/deltas");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { runId: "run-none", deltas: [] });
  assert.equal((await get(app, "/api/knowledge/executions/..%2Fx/deltas")).status, 404);
});

test("delta inspection reads the staged record beside the run; the result appears once applied", async () => {
  const staging = await import("./staging.js");
  const app = makeApp();
  const record = {
    id: "KD-1",
    runId: "run-7",
    instanceId: "inst-1",
    phaseId: "plan",
    attempt: 0,
    step: "s",
    status: "staged" as const,
    receivedAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
    delta: {
      schemaVersion: 1 as const,
      claims: [{ localId: "c", kind: "conclusion" as const, statement: "c" }],
    },
  };
  await staging.writeDeltaRecord(record);
  assert.deepEqual((await get(app, "/api/knowledge/deltas/KD-1")).body, record);
  assert.deepEqual((await get(app, "/api/knowledge/executions/run-7/deltas")).body, {
    runId: "run-7",
    deltas: [record],
  });
  assert.equal((await get(app, "/api/knowledge/deltas/KD-1/result")).status, 404);

  const result = {
    status: "applied" as const,
    deltaId: "KD-1",
    appliedAt: "2026-09-19T10:01:00.000Z",
    createdClaims: [{ localId: "c", claim: { id: "CONCLUSION-1", revision: 1 } }],
    createdRevisions: [],
    evidenceIds: [],
    justificationIds: [],
    consumptions: [],
    artifacts: [],
  };
  await staging.updateDeltaStatus("run-7", "applied", { at: "2026-09-19T10:01:00.000Z", result });
  assert.deepEqual((await get(app, "/api/knowledge/deltas/KD-1/result")).body, result);
  assert.equal((await get(app, "/api/knowledge/deltas/KD-1")).body.status, "applied");

  // An applied record is never demoted by a later sweep.
  const after = await staging.updateDeltaStatus("run-7", "superseded", {
    at: "later",
    reason: "x",
  });
  assert.equal(after?.status, "applied");
  assert.equal(await staging.updateDeltaStatus("run-none", "superseded", { at: "later" }), null);

  // There is no write surface: the agent boundary is the file, not the API.
  const res = await app.request("/api/knowledge/deltas", {
    method: "POST",
    headers: sameOrigin,
    body: "{}",
  });
  assert.equal(res.status, 404);
});

// ── KnowledgeContext inspection (Phase 4) ───────────────────────────────────
//
// What a run *received* comes from its invocation record, never from the
// ledger; what it *consumed* comes from the ledger. The routes join the two.

async function seedInvocation(runId: string, over: Record<string, unknown> = {}) {
  const runs = await import("../sources/runs.js");
  const context = await import("./context.js");
  const file = context.knowledgeContextFile(runId);
  await runs.writeInvocation({
    runId,
    instanceId: "inst-1",
    phaseId: "implement",
    step: "code",
    attempt: 0,
    runtime: "claude",
    bin: "claude",
    args: [],
    cwd: "/repo",
    envNames: [],
    envStripped: [],
    capabilities: null,
    limitations: [],
    materializedFiles: [],
    artifactDir: null,
    resultFile: null,
    knowledgeDeltaFile: null,
    knowledgeContextFile: file,
    knowledgeContext: {
      schemaVersion: 1,
      claims: [
        { id: "RULE-7", revision: 1 },
        { id: "FACT-12", revision: 1 },
      ],
      sha256: "cd".repeat(32),
    },
    channels: [],
    timeoutSeconds: null,
    deadlineAt: null,
    gitHead: null,
    startedAt: "2026-09-19T10:00:00.000Z",
    ...over,
  } as any);
  return file;
}

test("GET /executions/:runId/context: exact supplied refs, hash, consumptions and the three-way comparison; projection when the file is present", async () => {
  const app = makeApp();
  await seedExample(app);
  const file = await seedInvocation("run-ctx");
  // The run consumed one supplied claim and one it found on its own.
  const reg = await post(app, "/api/knowledge/executions/run-ctx/consumptions", {
    instanceId: "inst-1",
    phaseId: "implement",
    claims: ["RULE-7:v1", "DECISION-21:v1"],
  });
  assert.equal(reg.status, 201);

  const missingFile = await get(app, "/api/knowledge/executions/run-ctx/context");
  assert.equal(missingFile.status, 200);
  const body: ExecutionContextReport = missingFile.body;
  assert.deepEqual(body.execution, {
    runId: "run-ctx",
    instanceId: "inst-1",
    phaseId: "implement",
  });
  assert.deepEqual(body.context, {
    schemaVersion: 1,
    claims: [
      { id: "RULE-7", revision: 1 },
      { id: "FACT-12", revision: 1 },
    ],
    sha256: "cd".repeat(32),
    file,
  });
  assert.deepEqual(body.supplied, body.context.claims);
  assert.deepEqual(body.consumed, [
    { id: "RULE-7", revision: 1 },
    { id: "DECISION-21", revision: 1 },
  ]);
  assert.deepEqual(body.comparison, {
    suppliedAndConsumed: [{ id: "RULE-7", revision: 1 }],
    suppliedNotConsumed: [{ id: "FACT-12", revision: 1 }],
    consumedNotSupplied: [{ id: "DECISION-21", revision: 1 }],
  });
  // The file was never written for this hand-made record: no projection.
  assert.equal(body.projection, null);

  const { writeKnowledgeContextFile } = await import("./context.js");
  await writeKnowledgeContextFile(
    file,
    JSON.stringify({ schemaVersion: 1, generatedAt: "t", claims: [] }) + "\n",
  );
  const withFile = await get(app, "/api/knowledge/executions/run-ctx/context");
  assert.deepEqual(withFile.body.projection, { schemaVersion: 1, generatedAt: "t", claims: [] });
});

test("GET /executions/:runId/context: 404 for an unknown run, a malformed id, and a run launched without a context", async () => {
  const app = makeApp();
  assert.equal((await get(app, "/api/knowledge/executions/nope/context")).status, 404);
  assert.equal((await get(app, "/api/knowledge/executions/..%2Fx/context")).status, 404);
  await seedInvocation("run-plain", { knowledgeContextFile: null, knowledgeContext: null });
  assert.equal((await get(app, "/api/knowledge/executions/run-plain/context")).status, 404);
});

test("GET /claims/:key/supplied-to: the runs whose invocation records carry that exact revision, oldest first; 404 for an unknown claim", async () => {
  const app = makeApp();
  await seedExample(app);
  await seedInvocation("run-b", { startedAt: "2026-09-19T11:00:00.000Z" });
  await seedInvocation("run-a", { startedAt: "2026-09-19T10:00:00.000Z" });
  await seedInvocation("run-plain", { knowledgeContextFile: null, knowledgeContext: null });
  // A run that received a *different* revision of RULE-7 is not a match.
  await post(app, "/api/knowledge/claims/RULE-7/revise", { statement: "500" });
  await seedInvocation("run-v2", {
    knowledgeContext: {
      schemaVersion: 1,
      claims: [{ id: "RULE-7", revision: 2 }],
      sha256: "ef".repeat(32),
    },
  });

  const res = await get(app, "/api/knowledge/claims/RULE-7:v1/supplied-to");
  assert.equal(res.status, 200);
  const body: SuppliedToReport = res.body;
  assert.deepEqual(body.claim, { id: "RULE-7", revision: 1 });
  assert.deepEqual(
    body.executions.map((e) => e.execution.runId),
    ["run-a", "run-b"],
  );
  assert.deepEqual(body.executions[0], {
    execution: { runId: "run-a", instanceId: "inst-1", phaseId: "implement" },
    suppliedAt: "2026-09-19T10:00:00.000Z",
    sha256: "cd".repeat(32),
  });
  // The active revision is v2 now: a bare key resolves to it.
  const active = await get(app, "/api/knowledge/claims/RULE-7/supplied-to");
  assert.deepEqual(
    active.body.executions.map((e: any) => e.execution.runId),
    ["run-v2"],
  );
  assert.deepEqual(
    (await get(app, "/api/knowledge/claims/DECISION-21/supplied-to")).body.executions,
    [],
  );
  assert.equal((await get(app, "/api/knowledge/claims/NOPE/supplied-to")).status, 404);
});
