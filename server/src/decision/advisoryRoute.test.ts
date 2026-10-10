import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createApp, type AppDeps } from "../app.js";
import type { AuthService } from "../auth.js";
import type { ArgusConfig } from "../config.js";
import type { Engine } from "../pipelineEngine.js";
import { createUserStore } from "../userStore.js";
import { BUILTIN_BUILDERS } from "./definitions.js";
import { createMockProvider, type MockStep } from "./providers/mock.js";
import { createDecisionReader, type AdvisoryReadResult } from "./reader.js";
import { harness, RESIDUAL_P } from "./testSupport.js";

const headers = { host: "localhost:7777" };
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
const auth: AuthService = {
  isConfigured: async () => true,
  status: async () => ({ configured: true, username: "ops", role: "root" }),
  login: async () => ({ ok: false, reason: "bad-credentials" }),
  verify: () => ({ username: "ops", role: "root" }),
  logout: () => {},
  revokeSessions: () => {},
};
function makeApp(reader?: AppDeps["decisionsReader"], signedOut = false) {
  return createApp({
    config: signedOut ? { ...config, token: "test-token" } : config,
    engine: {} as Engine,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth: signedOut ? { ...auth, verify: () => null } : auth,
    analysis: {
      run: () => {
        throw new Error("advisory GET must not run analysis");
      },
      inFlight: () => 0,
    },
    ...(reader ? { decisionsReader: reader } : {}),
  });
}
function files(root: string): Array<[string, string]> {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((e): Array<[string, string]> => {
      const p = path.join(root, e.name);
      return e.isDirectory() ? files(p) : [[p, readFileSync(p).toString("base64")]];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}
async function fixture(step: MockStep = { distribution: RESIDUAL_P }) {
  const provider = createMockProvider({ script: [step] });
  const h = harness({ providers: { mock: provider } });
  const result = await h.service.assess({
    question: "run.failure-cause.residual",
    version: 1,
    subject: { kind: "run", runId: "run-1" },
    provider: "mock",
  });
  assert.ok(result.ok);
  const a = result.assessment;
  const reader = createDecisionReader({
    journal: h.journal,
    registry: h.registry,
    sources: h.sources,
    builders: BUILTIN_BUILDERS,
    consumers: [
      {
        id: "run-advisory",
        question: a.question,
        projection: a.snapshot.projection,
        providers: [a.provider],
      },
    ],
  });
  const app = makeApp(reader);
  const url = `/api/decisions/assessments/${a.id}?consumer=run-advisory&runId=run-1`;
  return { ...h, provider, a, reader, app, url };
}

test("advisory route is unavailable by default without implicit journal or provider setup", async () => {
  const response = await makeApp().request(
    "/api/decisions/assessments/DA-test000001?consumer=run-advisory&runId=run-1",
    { headers },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, reason: "reader-unavailable" });
});

test("authenticated actual-journal reads are repeatable and preserve files and provider call count", async () => {
  const h = await fixture();
  const before = files(h.root);
  const response = await h.app.request(h.url, { headers });
  assert.equal(response.status, 200);
  const first = await response.text();
  const body = JSON.parse(first);
  assert.equal(body.value.presentation, "current");
  assert.equal(body.value.authority, "inference-only");
  assert.equal(body.value.cost.status, "unknown");
  assert.equal(body.value.cost.usd, null);
  assert.equal(body.value.provenance.digest.length, 64);
  assert.equal(await (await h.app.request(h.url, { headers })).text(), first);
  assert.deepEqual(files(h.root), before);
  assert.equal(h.provider.calls.length, 1);
});

test("API auth and host validation reject before invoking the configured reader", async () => {
  let calls = 0;
  const reader: AppDeps["decisionsReader"] = {
    read: async () => {
      calls++;
      throw new Error("must not reach reader");
    },
  };
  const app = makeApp(reader, true);
  const url = "/api/decisions/assessments/DA-test000001?consumer=run-advisory&runId=run-1";
  assert.equal((await app.request(url, { headers })).status, 401);
  assert.equal(
    (
      await app.request(url, {
        headers: { host: "attacker.example", authorization: "Bearer test-token" },
      })
    ).status,
    403,
  );
  assert.equal(calls, 0);
});

test("query identities are required and cannot select a phase-attempt subject", async () => {
  let calls = 0;
  const reader: AppDeps["decisionsReader"] = {
    read: async () => {
      calls++;
      throw new Error("must not reach reader");
    },
  };
  const app = makeApp(reader);
  for (const query of [
    "",
    "?consumer=run-advisory",
    "?runId=run-1",
    "?consumer=run-advisory&runId=",
    "?consumer=run-advisory&runId=run-1&runId=run-2",
    "?consumer=run-advisory&instanceId=i1&phaseId=p1&attempt=1",
  ]) {
    const response = await app.request(`/api/decisions/assessments/DA-test000001${query}`, {
      headers,
    });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test("missing and unsupported identities have typed HTTP refusals", async () => {
  const h = await fixture();
  for (const [url, status, reason] of [
    [h.url.replace(h.a.id, "DA-missing0001"), 404, "unknown-assessment"],
    [h.url.replace("run-advisory", "unknown"), 403, "unknown-consumer"],
    [h.url.replace("runId=run-1", "runId=other"), 409, "subject-mismatch"],
    [h.url.replace(h.a.id, "invalid"), 400, "invalid-id"],
  ] as const) {
    const response = await h.app.request(url, { headers });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok: false, reason });
  }
});

for (const [kind, step] of [
  ["failed", { throws: "no output" }],
  ["abstained", { abstain: "cannot infer" }],
] as const) {
  test(`advisory API preserves ${kind} without favorable evidence`, async () => {
    const h = await fixture(step);
    const response = await h.app.request(h.url, { headers });
    assert.equal(response.status, 200);
    const body = (await response.json()) as AdvisoryReadResult;
    assert.ok(body.ok);
    assert.equal(body.value.assessment.outcome.status, kind);
    assert.equal(body.value.usable, false);
    assert.equal(body.value.cost.usd, null);
  });
}

for (const state of ["stale", "missing-source", "corrupt"] as const) {
  test(`advisory API preserves ${state} state and does not mutate journal`, async () => {
    const h = await fixture();
    if (state === "stale") h.mem.runs.get("run-1")!.prompt = "Different task";
    else if (state === "missing-source") h.mem.runs.delete("run-1");
    else
      writeFileSync(
        files(h.root).find(([p]) => p.endsWith(`${h.a.snapshot.sha256}.json`))![0],
        "corrupt",
      );
    const before = files(h.root);
    const response = await h.app.request(h.url, { headers });
    assert.equal(response.status, 200);
    const body = (await response.json()) as AdvisoryReadResult;
    assert.ok(body.ok);
    assert.equal(
      body.value.presentation,
      state === "missing-source" ? "historical" : state === "corrupt" ? "unavailable" : "stale",
    );
    assert.equal(body.value.usable, false);
    assert.deepEqual(files(h.root), before);
  });
}

test("malformed actual-journal assessment has a typed 422 response", async () => {
  const h = await fixture();
  const retained = await h.journal.loadSnapshot(h.a.snapshot.sha256);
  assert.equal(retained.status, "retained");
  if (retained.status !== "retained") return;
  const bad = {
    ...h.a,
    id: "DA-malformedroute01",
    snapshot: { sha256: h.a.snapshot.sha256, bytes: h.a.snapshot.bytes },
  } as typeof h.a;
  await h.journal.append(bad, retained.snapshot);
  const response = await h.app.request(h.url.replace(h.a.id, bad.id), { headers });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { ok: false, reason: "malformed-assessment" });
});

test("unsupported complete provider identity returns 403", async () => {
  const h = await fixture();
  const reader = createDecisionReader({
    journal: h.journal,
    registry: h.registry,
    sources: h.sources,
    builders: BUILTIN_BUILDERS,
    consumers: [
      {
        id: "run-advisory",
        question: h.a.question,
        projection: h.a.snapshot.projection,
        providers: [{ ...h.a.provider, reportedModel: "different-model" }],
      },
    ],
  });
  const response = await makeApp(reader).request(h.url, { headers });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, reason: "unsupported-provider" });
});

test("unavailable journal has a typed 503 response", async () => {
  const h = await fixture();
  const reader = createDecisionReader({
    journal: {
      read: async () => {
        throw new Error("read unavailable");
      },
      loadSnapshot: (sha) => h.journal.loadSnapshot(sha),
    },
    registry: h.registry,
    sources: h.sources,
    builders: BUILTIN_BUILDERS,
    consumers: [
      {
        id: "run-advisory",
        question: h.a.question,
        projection: h.a.snapshot.projection,
        providers: [h.a.provider],
      },
    ],
  });
  const response = await makeApp(reader).request(h.url, { headers });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, reason: "journal-unavailable" });
});
