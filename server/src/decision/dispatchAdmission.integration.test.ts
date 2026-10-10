import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createEvaluationCoordinator } from "./evaluationCoordinator.js";
import { InvocationLedger } from "./invocationLedger.js";
import { harness, tempRoot, RESIDUAL_P } from "./testSupport.js";
import { createMockProvider } from "./providers/mock.js";
import { h2Harness } from "./h2/testSupport.js";
import { createAnalysisRunner, type AnalysisDispatchAdmission } from "../sources/analysis.js";
async function fixture(
  options: {
    maxBytes?: number;
    writeFail?: boolean;
    deny?: string;
    outcome?: import("@argus/contracts").DecisionOutcome;
    costUsd?: number | null;
  } = {},
) {
  const provider = createMockProvider({
    script: () => (options.outcome ? { outcome: options.outcome } : { distribution: RESIDUAL_P }),
    costUsd: options.costUsd === undefined ? 0.1 : options.costUsd,
  });
  const h = harness({ providers: { mock: provider } });
  const parent = await h.service.assess({
    question: "run.failure-cause.residual",
    subject: { kind: "run", runId: "run-1" },
    provider: "mock",
  });
  assert.ok(parent.ok);
  const now = () => new Date("2026-10-10T01:00:00.000Z"),
    expiresAt = "2026-10-11T00:00:00.000Z",
    d = "a".repeat(64);
  const reservations = new Map<string, import("./invocationLedger.js").Reservation>();
  const settlements = new Map<string, import("./invocationLedger.js").InvocationSettlement>();
  const owner = {
    identity: "fixture",
    fence: "1",
    expiresAt,
    ledgerFile: "",
    scope: "fixture",
    policyDigest: d,
  };
  const ownership = {
    assertCurrent: (
      binding: { ledgerFile: string; scope: string; policyDigest: string },
      expected: import("./invocationLedger.js").Ownership,
    ): void => {
      assert.deepEqual(binding, {
        ledgerFile: owner.ledgerFile,
        scope: owner.scope,
        policyDigest: owner.policyDigest,
      });
      assert.deepEqual(owner, expected, "fixture ownership must still match pinned receipt");
    },
    require: async () => {
      if (options.deny === "ownership") throw Error("denied");
      return owner;
    },
  };
  const ledger = new InvocationLedger({
    file: path.join(tempRoot(), "ledger.jsonl"),
    requireOwnership: async () => {
      await ownership.require();
    },
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    ...(options.writeFail
      ? {
          write: async () => {
            throw Error("write refused");
          },
        }
      : {}),
  });
  owner.ledgerFile = ledger.file;
  const gate: import("./evaluationCoordinator.js").SharedEvaluationGate = {
    acquire: async (b: import("./evaluationCoordinator.js").AdmissionBinding) => {
      if (options.deny === "gate") throw Error("unknown spend or insufficient allowance");
      const r = {
        id: `R-${b.invocationId}`,
        invocationId: b.invocationId,
        requestDigest: b.requestDigest,
        scope: b.scope,
        policyDigest: b.policyDigest,
        allowanceUsd: b.allowanceUsd,
      };
      reservations.set(b.invocationId, r);
      return r;
    },
    validate: async () => {
      if (options.deny === "validate") throw Error("expired reservation");
    },
    lookup: async (id: string) => reservations.get(id) ?? null,
    orphans: async () => [...reservations.values()],
    recoverOrphan: async () => null,
    settle: async (
      r: import("./invocationLedger.js").Reservation,
      s: import("./invocationLedger.js").InvocationSettlement,
    ) => {
      settlements.set(r.invocationId, s);
    },
    cancelProvenUncalled: async (r: import("./invocationLedger.js").Reservation) => {
      reservations.delete(r.invocationId);
    },
  };
  const deps = {
    ledger,
    service: h.service,
    journal: h.journal,
    ownership,
    gate,
    now,
    authorization: {
      authorize: async (b: import("./evaluationCoordinator.js").AdmissionBinding) => {
        if (options.deny === "authorization") throw Error("denied");
        return {
          reference: "grant",
          digest: d,
          principal: "operator",
          scope: b.scope,
          issuedAt: "2026-10-10T00:00:00.000Z",
          expiresAt: options.deny === "expired" ? "2026-10-10T00:01:00.000Z" : expiresAt,
          invocationId: b.invocationId,
          requestDigest: b.requestDigest,
          reportedModels: null,
        };
      },
    },
    preflight: {
      check: async (b: import("./evaluationCoordinator.js").AdmissionBinding) => {
        if (options.deny === "preflight") throw Error("unsupported account");
        return {
          reference: "preflight",
          digest: d,
          expiresAt,
          invocationId: b.invocationId,
          requestDigest: b.requestDigest,
        };
      },
    },
  };
  const request = {
    namespace: "fixture",
    key: "one",
    assessmentId: parent.assessment.id,
    provider: "mock",
    sample: 0,
    scope: "fixture",
    policyDigest: d,
    allowanceUsd: 1,
  };
  return {
    h,
    provider,
    parent: parent.assessment,
    ledger,
    deps,
    request,
    reservations,
    settlements,
    create: () => createEvaluationCoordinator(deps),
  };
}

async function realChain(mode: string) {
  const f = await fixture(),
    h = h2Harness();
  const parent = await h.service.assess({
    question: "run.failure-cause.residual",
    subject: { kind: "run", runId: "run-1" },
    provider: "claude-cli",
  });
  assert.ok(parent.ok);
  let time = "2026-10-10T01:00:00.000Z",
    fence = "1",
    spawns = 0;
  const owner = await f.deps.ownership.require();
  f.deps.ownership.require = async () => ({
    ...owner,
    fence,
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
  f.deps.ownership.assertCurrent = (binding, expected) => {
    assert.equal(binding.ledgerFile, f.ledger.file);
    assert.equal(binding.scope, owner.scope);
    assert.equal(binding.policyDigest, owner.policyDigest);
    assert.equal(fence, expected.fence, "current fence changed");
  };
  const mutate = () => {
    if (mode.includes("expiry")) time = "2026-10-12T01:00:00.000Z";
    else fence = "2";
  };
  const runner = createAnalysisRunner({
    enabled: () => true,
    blocked: async () => {
      await Promise.resolve();
      if (mode.startsWith("budget")) mutate();
      return false;
    },
    meter: async () => {},
    spawn: () => {
      spawns++;
      return {
        kill() {},
        done: Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            result: JSON.stringify({ p: RESIDUAL_P }),
            total_cost_usd: 0.1,
          }),
          error: null,
        }),
      };
    },
  });
  h.runner.run = runner.run;
  if (mode === "unsupported-runner") delete h.runner.runWithAdmission;
  else
    h.runner.runWithAdmission = (req, parse, admission) =>
      runner.runWithAdmission!(req, parse, async () => {
        const proof = await admission();
        if (mode.startsWith("microtask")) queueMicrotask(mutate);
        return proof;
      });
  const deps = { ...f.deps, now: () => new Date(time), service: h.service, journal: h.journal };
  const request = { ...f.request, assessmentId: parent.assessment.id, provider: "claude-cli" };
  return {
    ...f,
    h,
    request,
    deps,
    spawns: () => spawns,
    create: () => createEvaluationCoordinator(deps),
  };
}

for (const mode of [
  "budget-expiry",
  "budget-fence",
  "microtask-expiry",
  "microtask-fence",
  "unsupported-runner",
]) {
  test(`real service Claude runner refuses ${mode} without spawn or assessment`, async () => {
    const f = await realChain(mode);
    const result = await f.create().execute(f.request);
    assert.equal(f.spawns(), 0);
    assert.equal((await f.h.journal.read()).entries.length, 1);
    assert.equal(result.state, "refused-before-call");
    assert.equal((await f.create().execute(f.request)).state, "refused-before-call");
    assert.equal(f.spawns(), 0);
  });
}

test("real service Claude runner valid admission spawns once across duplicate delivery and restart", async () => {
  const f = await realChain("valid");
  assert.equal((await f.create().execute(f.request)).state, "recorded");
  assert.equal((await f.create().execute(f.request)).state, "recorded");
  await f.create().reconcile();
  assert.equal((await f.create().execute(f.request)).state, "recorded");
  assert.equal(f.spawns(), 1);
  assert.equal((await f.h.journal.read()).entries.length, 2);
});

for (const mode of ["throw", "reject", "missing-final", "async-final", "final-denial"]) {
  test(`real service Claude runner fails closed for admission ${mode}`, async () => {
    const f = await realChain("valid"),
      request = { assessmentId: f.request.assessmentId, provider: "claude-cli" };
    const admission = (async () => {
      if (mode === "throw") throw Error("guard threw");
      if (mode === "reject") return { ok: false, detail: "guard refused" };
      if (mode === "missing-final") return { ok: true };
      if (mode === "async-final") return { ok: true, validateNow: async () => ({ ok: true }) };
      return { ok: true, validateNow: () => ({ ok: false, detail: "final denied" }) };
    }) as AnalysisDispatchAdmission;
    const result = await f.h.service.reEvaluate({ ...request, beforeProviderCall: admission });
    assert.equal(result.ok, false);
    assert.equal(result.providerCalled, false);
    assert.equal(!result.ok && result.reason, "dispatch-refused");
    assert.equal(f.spawns(), 0);
    assert.equal((await f.h.journal.read()).entries.length, 1);
  });
}

test("real Claude refusal with lost settlement stays unknown and never resends", async () => {
  const f = await realChain("unsupported-runner");
  const append = f.ledger.appendSettlement.bind(f.ledger);
  f.ledger.appendSettlement = async () => {
    throw Error("lost refusal settlement");
  };
  assert.equal((await f.create().execute(f.request)).state, "unknown-outcome");
  f.ledger.appendSettlement = append;
  assert.equal((await f.create().reconcile())[0]?.state, "unknown-outcome");
  assert.equal((await f.create().execute(f.request)).state, "unknown-outcome");
  const settlement = [...f.settlements.values()][0];
  assert.equal(settlement.providerCalled, "unknown");
  assert.equal(settlement.costUsd, null);
  assert.equal(f.spawns(), 0);
  assert.equal((await f.h.journal.read()).entries.length, 1);
});

test("real Claude final synchronous signal check rejects cancellation after async proof", async () => {
  const f = await realChain("valid"),
    signal = new AbortController();
  const run = f.h.runner.runWithAdmission!.bind(f.h.runner);
  f.h.runner.runWithAdmission = (req, parse, admission) =>
    run(req, parse, async () => {
      const proof = await admission();
      queueMicrotask(() => signal.abort());
      return proof;
    });
  const result = await f.h.service.reEvaluate({
    assessmentId: f.request.assessmentId,
    provider: "claude-cli",
    signal: signal.signal,
    beforeProviderCall: async () => ({ ok: true, validateNow: () => ({ ok: true }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.providerCalled, false);
  assert.equal(f.spawns(), 0);
  assert.equal((await f.h.journal.read()).entries.length, 1);
});
