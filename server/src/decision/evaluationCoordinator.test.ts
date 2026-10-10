import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { createEvaluationCoordinator } from "./evaluationCoordinator.js";
import { InvocationLedger } from "./invocationLedger.js";
import { harness, tempRoot, RESIDUAL_P } from "./testSupport.js";
import { createMockProvider } from "./providers/mock.js";
import { canonicalDigest } from "./canonical.js";
import { h2Harness } from "./h2/testSupport.js";

export async function fixture(
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

async function claudeGuardFixture() {
  const f = await fixture();
  const h = h2Harness();
  let runnerCalls = 0;
  const run = h.runner.run.bind(h.runner);
  h.runner.run = (...args) => {
    runnerCalls++;
    return run(...args);
  };
  const parent = await h.service.assess({
    question: "run.failure-cause.residual",
    subject: { kind: "run", runId: "run-1" },
    provider: "claude-cli",
  });
  assert.ok(parent.ok);
  writeFileSync(path.join(h.root, "provider-cwd", "unsafe"), "x");
  const baseline = runnerCalls;
  const request = { ...f.request, assessmentId: parent.assessment.id, provider: "claude-cli" };
  const deps = { ...f.deps, service: h.service, journal: h.journal };
  const acquire = deps.gate.acquire;
  deps.gate.acquire = async (binding) => {
    if ([...f.settlements.values()].some((s) => s.providerCalled !== "no" && s.costUsd === null))
      throw Error("unknown spent cost");
    return acquire(binding);
  };
  return {
    ...f,
    h,
    request,
    create: () => createEvaluationCoordinator(deps),
    extraRunnerCalls: () => runnerCalls - baseline,
  };
}

test("real Claude no-call refusal settles no spend, admits a fresh key and survives duplicate delivery and restart", async () => {
  const f = await claudeGuardFixture();
  const first = await f.create().execute(f.request);
  assert.equal(first.state, "refused-before-call");
  assert.equal(f.extraRunnerCalls(), 0);
  assert.equal(f.h.spawns.length, 1, "only the parent assessment spawned");
  assert.equal((await f.h.journal.read()).entries.length, 1, "refusal appended no assessment");
  const settlements = [...f.settlements.values()];
  assert.equal(settlements[0].providerCalled, "no");
  assert.equal(settlements[0].costUsd, 0);
  assert.equal((await f.create().execute(f.request)).state, "refused-before-call");
  assert.equal(
    (await f.create().execute({ ...f.request, key: "fresh" })).state,
    "refused-before-call",
  );
  await f.create().reconcile();
  assert.equal((await f.create().execute(f.request)).state, "refused-before-call");
  assert.equal(f.settlements.size, 2);
  assert.equal(f.extraRunnerCalls(), 0);
  assert.equal(f.h.spawns.length, 1);
});

test("lost durable no-call settlement cannot be reconstructed from missing journal evidence or retried", async () => {
  const f = await claudeGuardFixture();
  const append = f.ledger.appendSettlement.bind(f.ledger);
  f.ledger.appendSettlement = async () => {
    throw Error("lost settlement publication");
  };
  assert.equal((await f.create().execute(f.request)).state, "unknown-outcome");
  assert.equal(f.extraRunnerCalls(), 0);
  assert.equal((await f.h.journal.read()).entries.length, 1);
  f.ledger.appendSettlement = append;
  assert.equal((await f.create().reconcile())[0]?.state, "unknown-outcome");
  const settlement = [...f.settlements.values()][0];
  assert.equal(settlement.providerCalled, "unknown");
  assert.equal(settlement.costUsd, null);
  assert.equal((await f.create().execute(f.request)).state, "unknown-outcome");
  assert.equal(
    (await f.create().execute({ ...f.request, key: "fresh" })).state,
    "refused-before-call",
  );
  assert.equal(f.extraRunnerCalls(), 0);
});
test("concurrent duplicate delivery across factories calls once and preserves original parent bytes", async () => {
  const f = await fixture(),
    before = canonicalDigest(f.parent).text,
    start = f.provider.calls.length;
  const results = await Promise.all(Array.from({ length: 8 }, () => f.create().execute(f.request)));
  assert.equal(f.provider.calls.length - start, 1);
  assert.ok(results.every((r) => r.state === "recorded" || r.state === "in-progress"));
  assert.equal((await f.create().execute(f.request)).state, "recorded");
  assert.equal(
    canonicalDigest(
      (await f.h.journal.read()).entries.find((e) => e.assessment.id === f.parent.id)!.assessment,
    ).text,
    before,
  );
  assert.equal(
    (await f.create().execute({ ...f.request, sample: 1 })).state,
    "refused-before-call",
  );
  assert.equal(f.provider.calls.length - start, 1);
});
test("required grants, ownership, preflight, gate, expiry, capacity and intent publication refuse before calls", async () => {
  for (const deny of ["ownership", "authorization", "preflight", "gate", "expired", "validate"]) {
    const f = await fixture({ deny }),
      start = f.provider.calls.length;
    await f.create().execute(f.request);
    assert.equal(f.provider.calls.length, start, deny);
  }
  for (const opts of [{ maxBytes: 100 }, { writeFail: true }]) {
    const f = await fixture(opts),
      start = f.provider.calls.length;
    await f.create().execute(f.request);
    assert.equal(f.provider.calls.length, start);
    if (opts.writeFail)
      assert.equal(f.reservations.size, 1, "uncertain publication retains reservation");
  }
});
test("reconcile durable intent missing result conservatively, never resend", async () => {
  const f = await fixture();
  let release!: () => void;
  const pause = new Promise<void>((r) => {
    release = r;
  });
  const service = {
    ...f.h.service,
    reEvaluate: async () => {
      await pause;
      throw Error("crash");
    },
  };
  const c = createEvaluationCoordinator({ ...f.deps, service });
  const live = c.execute(f.request);
  while ((await f.ledger.load()).intents.size === 0) await new Promise((r) => setTimeout(r, 2));
  assert.equal((await f.create().reconcile())[0]?.state, "in-progress");
  release();
  await live;
  assert.equal((await f.create().execute(f.request)).state, "unknown-outcome");
  assert.equal(f.provider.calls.length, 1);
});

test("result publication before settlement failure reconciles exact result without resend", async () => {
  const f = await fixture(),
    append = f.ledger.appendSettlement.bind(f.ledger);
  let refuse = true;
  f.ledger.appendSettlement = async (s) => {
    if (refuse) {
      refuse = false;
      throw Error("crash before settlement");
    }
    return append(s);
  };
  const start = f.provider.calls.length,
    first = await f.create().execute(f.request);
  assert.equal(first.state, "unknown-outcome");
  assert.equal(f.provider.calls.length, start + 1);
  const result = (await f.create().reconcile())[0];
  assert.equal(result?.state, "recorded");
  assert.equal((await f.create().execute(f.request)).state, "recorded");
  assert.equal(f.provider.calls.length, start + 1);
});
test("durable settlement survives accounting split window and retries accounting idempotently", async () => {
  const f = await fixture(),
    settle = f.deps.gate.settle;
  let fail = true;
  f.deps.gate.settle = async (r, s) => {
    if (fail) {
      fail = false;
      throw Error("accounting crash");
    }
    return settle(r, s);
  };
  const start = f.provider.calls.length;
  assert.equal((await f.create().execute(f.request)).state, "unknown-outcome");
  assert.equal((await f.ledger.load()).settlements.size, 1);
  assert.equal(f.settlements.size, 0);
  assert.equal((await f.create().reconcile())[0]?.state, "recorded");
  assert.equal(f.settlements.size, 1);
  assert.equal((await f.create().execute(f.request)).state, "recorded");
  assert.equal(f.provider.calls.length, start + 1);
});
test("crash after intent before dispatch becomes permanently unknown with null cost", async () => {
  const f = await fixture();
  const prepare = f.h.service.prepareReEvaluation.bind(f.h.service);
  let saved: import("./invocationLedger.js").InvocationIntent | undefined;
  const append = f.ledger.appendIntent.bind(f.ledger);
  f.ledger.appendIntent = async (i) => {
    saved = i;
    await append(i);
    throw Error("lost acknowledgement");
  };
  const start = f.provider.calls.length;
  assert.equal((await f.create().execute(f.request)).state, "unknown-outcome");
  assert.equal(f.provider.calls.length, start);
  assert.ok(saved);
  const result = (await f.create().reconcile())[0];
  assert.equal(result?.state, "unknown-outcome");
  assert.ok(result && "costUsd" in result);
  assert.equal(result.costUsd, null);
  assert.equal((await f.create().execute(f.request)).state, "unknown-outcome");
  assert.equal(f.provider.calls.length, start);
  assert.ok((await prepare({ assessmentId: f.parent.id, provider: "mock" })).ok);
});
test("exact recovery rejects every bound identity conflict and corrupt journal evidence", async () => {
  const changes: ((a: import("@argus/contracts").DecisionAssessment) => void)[] = [
    (a) => {
      a.mode = "advisory";
    },
    (a) => {
      a.reEvaluates = "DA-otherparent";
    },
    (a) => {
      a.sample++;
    },
    (a) => {
      a.question.version++;
    },
    (a) => {
      a.snapshot.projection.id = "other";
    },
    (a) => {
      a.snapshot.bytes++;
    },
    (a) => {
      a.subject = { kind: "run", runId: "other" };
    },
    (a) => {
      a.provider.requestedModel = "other";
    },
    (a) => {
      a.provider.adapterVersion++;
    },
    (a) => {
      a.provider.elicitation = "native";
    },
  ];
  for (const change of changes) {
    const f = await fixture(),
      append = f.ledger.appendSettlement.bind(f.ledger);
    let stop = true;
    f.ledger.appendSettlement = async (s) => {
      if (stop) throw Error("crash");
      return append(s);
    };
    await f.create().execute(f.request);
    stop = false;
    const originalRead = f.h.journal.read.bind(f.h.journal);
    const journal = {
      read: async () => {
        const v = await originalRead();
        const e = v.entries.find((e) => e.assessment.id !== f.parent.id)!;
        change(e.assessment);
        e.digest = (await import("./storage.js")).encodeLine("assessment", e.assessment).digest;
        return v;
      },
      loadSnapshot: f.h.journal.loadSnapshot.bind(f.h.journal),
    };
    const start = f.provider.calls.length;
    assert.equal(
      (await createEvaluationCoordinator({ ...f.deps, journal }).reconcile())[0]?.state,
      "integrity-halt",
    );
    assert.equal(f.provider.calls.length, start);
  }
  const f = await fixture(),
    read = f.h.journal.read.bind(f.h.journal);
  const journal = {
    read: async () => {
      const v = await read();
      v.notices.push({ kind: "corrupt-line", detail: "fixture damage" });
      return v;
    },
    loadSnapshot: f.h.journal.loadSnapshot.bind(f.h.journal),
  };
  assert.equal(
    (await createEvaluationCoordinator({ ...f.deps, journal }).execute(f.request)).state,
    "integrity-halt",
  );
  assert.equal(f.provider.calls.length, 1);
});
test("missing required runtime capabilities fail closed", async () => {
  for (const key of ["ownership", "authorization", "preflight", "gate"] as const) {
    const f = await fixture();
    const deps = { ...f.deps };
    delete (deps as Partial<typeof deps>)[key];
    assert.equal(
      (await createEvaluationCoordinator(deps).execute(f.request)).state,
      "refused-before-call",
    );
    assert.equal(f.provider.calls.length, 1);
  }
});
test("changed reservation binding refuses and uncertain orphan absence never cancels", async () => {
  const f = await fixture(),
    acquire = f.deps.gate.acquire;
  f.deps.gate.acquire = async (b) => ({ ...(await acquire(b)), requestDigest: "b".repeat(64) });
  assert.equal((await f.create().execute(f.request)).state, "integrity-halt");
  assert.equal(f.provider.calls.length, 1);
  assert.equal(f.reservations.size, 1);
});
test("ownership fence and evidence expiry are rechecked after asynchronous gate validation", async () => {
  for (const change of ["fence", "expiry"]) {
    const f = await fixture();
    const requireOwner = f.deps.ownership.require;
    let fenced = false;
    f.deps.ownership.require = async () => ({
      ...(await requireOwner()),
      fence: fenced ? "changed" : "1",
    });
    f.deps.gate.validate = async () => {
      if (change === "fence") fenced = true;
      else f.deps.now = () => new Date("2026-10-12T00:00:00.000Z");
    };
    const start = f.provider.calls.length;
    await f.create().execute(f.request);
    assert.equal(f.provider.calls.length, start, change);
  }
});
test("wrong ledger or shared scope ownership refuses", async () => {
  for (const field of ["ledgerFile", "scope", "policyDigest"]) {
    const f = await fixture(),
      requireOwner = f.deps.ownership.require;
    f.deps.ownership.require = async () => ({ ...(await requireOwner()), [field]: "wrong" });
    assert.equal((await f.create().execute(f.request)).state, "integrity-halt");
    assert.equal(f.provider.calls.length, 1);
  }
});

test("orphan recovery requires authoritative no-call proof with current fence", async () => {
  for (const mode of ["uncertain", "proven", "stale"]) {
    const f = await fixture({ writeFail: true });
    await f.create().execute(f.request);
    assert.equal(f.reservations.size, 1);
    let changed = false;
    const requireOwner = f.deps.ownership.require;
    f.deps.ownership.require = async () => ({
      ...(await requireOwner()),
      fence: changed ? "new-fence" : "1",
    });
    f.deps.gate.recoverOrphan = async (r) => {
      if (mode === "uncertain") return null;
      if (mode === "stale") changed = true;
      return {
        invocationId: r.invocationId,
        reservationId: r.id,
        fence: "1",
        digest: "a".repeat(64),
        providerCalled: "no",
      };
    };
    await f.create().reconcile();
    assert.equal(f.reservations.size, mode === "proven" ? 0 : 1, mode);
    assert.equal(f.provider.calls.length, 1);
  }
});
test("admission authority binds complete immutable preparation digest", async () => {
  const f = await fixture();
  let observed = "";
  const authorize = f.deps.authorization.authorize;
  f.deps.authorization.authorize = async (b) => {
    observed = b.requestDigest;
    return authorize(b);
  };
  await f.create().execute(f.request);
  const saved = [...(await f.ledger.load()).intents.values()][0]!;
  assert.equal(
    observed,
    canonicalDigest({ request: f.request, preparationDigest: saved.intent.preparation.digest })
      .sha256,
  );
});
test("atomic shared gate rejects insufficient allowance and unknown possible spend", async () => {
  const f = await fixture();
  const acquire = f.deps.gate.acquire;
  f.deps.gate.acquire = async (b) => {
    let spent = 0;
    for (const [id, r] of f.reservations) {
      const s = f.settlements.get(id);
      if (s && s.costUsd === null && s.providerCalled !== "no")
        throw Error("unknown possible spend");
      spent += s ? (s.costUsd ?? 0) : r.allowanceUsd;
    }
    if (spent + b.allowanceUsd > 1) throw Error("insufficient shared allowance");
    return acquire(b);
  };
  const first = await f.create().execute({ ...f.request, allowanceUsd: 0.8 });
  assert.equal(first.state, "recorded");
  const start = f.provider.calls.length;
  assert.equal(
    (await f.create().execute({ ...f.request, key: "two", allowanceUsd: 1 })).state,
    "refused-before-call",
  );
  assert.equal(f.provider.calls.length, start);
  const prior = [...f.settlements.values()][0]!;
  f.settlements.set(prior.invocationId, { ...prior, costUsd: null });
  assert.equal(
    (await f.create().execute({ ...f.request, key: "three", allowanceUsd: 0 })).state,
    "refused-before-call",
  );
  assert.equal(f.provider.calls.length, start);
});
test("failed and abstained recorded outcomes retain their classification and unknown cost", async () => {
  for (const outcome of [
    { status: "failed" as const, failure: "mock-failure", detail: "failed" },
    { status: "abstained" as const, reason: "uncertain" },
  ]) {
    const f = await fixture({ outcome, costUsd: null });
    const r = await f.create().execute(f.request);
    assert.equal(r.state, "recorded");
    assert.ok("outcome" in r);
    assert.equal(r.outcome, outcome.status);
    assert.ok("costUsd" in r);
    assert.equal(r.costUsd, null);
  }
});
test("real service provider identity mismatch halts with unknown actual identity and no resend", async () => {
  const f = await fixture(),
    assess = f.provider.assessWithAdmission!.bind(f.provider);
  f.provider.assessWithAdmission = async (q, s, signal, admission) => {
    const r = await assess(q, s, signal, admission);
    return { ...r, identity: { ...r.identity, provider: "human" } };
  };
  const result = await f.create().execute(f.request);
  assert.equal(result.state, "integrity-halt");
  assert.ok("actualProvider" in result);
  assert.equal(result.actualProvider, null);
  assert.ok("outcome" in result);
  assert.equal(result.outcome, "failed");
  assert.ok("resultDigest" in result);
  assert.ok(result.resultDigest);
  assert.equal(f.provider.calls.length, 2);
  assert.equal((await f.create().execute(f.request)).state, "integrity-halt");
  assert.equal(f.provider.calls.length, 2);
});
test("real service thrown provider records failure without inventing response identity or cost", async () => {
  const f = await fixture();
  f.provider.assessWithAdmission = async () => {
    throw Error("fixture crash");
  };
  const result = await f.create().execute(f.request);
  assert.equal(result.state, "recorded");
  assert.ok("actualProvider" in result);
  assert.equal(result.actualProvider, null);
  assert.ok("costUsd" in result);
  assert.equal(result.costUsd, null);
  assert.ok("outcome" in result);
  assert.equal(result.outcome, "failed");
  assert.equal((await f.create().execute(f.request)).state, "recorded");
});

test("identical terminal delivery uses stored preparation when provider preparation changes", async () => {
  const f = await fixture();
  assert.equal((await f.create().execute(f.request)).state, "recorded");
  f.deps.service.prepareReEvaluation = async () => ({
    ok: false,
    reason: "unknown-provider",
    detail: "provider drift",
    providerCalled: false,
  });
  assert.equal((await f.create().execute(f.request)).state, "recorded");
  assert.equal(f.provider.calls.length, 2);
});
test("unresolved orphan with absent ledger independently prevents fresh admission", async () => {
  const f = await fixture(),
    file = f.ledger.file;
  assert.equal((await f.create().execute(f.request)).state, "recorded");
  await (await import("node:fs/promises")).unlink(file);
  const before = f.provider.calls.length;
  assert.equal(f.reservations.size, 1);
  const result = await f.create().execute(f.request);
  assert.equal(f.provider.calls.length, before);
  assert.equal(result.state, "integrity-halt");
  assert.equal(f.reservations.size, 1);
});
test("shared ownership receipt mutation before intent cannot change admitted fence", async () => {
  const f = await fixture(),
    shared = await f.deps.ownership.require(),
    acquire = f.deps.gate.acquire;
  f.deps.ownership.require = async () => shared;
  f.deps.gate.acquire = async (b) => {
    shared.fence = "changed";
    return acquire(b);
  };
  const start = f.provider.calls.length;
  await f.create().execute(f.request);
  assert.equal(f.provider.calls.length, start);
});
test("actual service boundary rechecks grant expiry and fenced ownership after retained async validation", async () => {
  for (const mode of ["expiry", "fence"]) {
    const f = await fixture(),
      load = f.h.journal.loadSnapshot.bind(f.h.journal),
      requireOwner = f.deps.ownership.require;
    let reads = 0,
      changed = false;
    f.deps.ownership.require = async () => ({
      ...(await requireOwner()),
      expiresAt: "2027-01-01T00:00:00.000Z",
      fence: changed ? "new-fence" : "1",
    });
    f.h.journal.loadSnapshot = async (hash) => {
      const result = await load(hash);
      if (++reads === 2) {
        if (mode === "expiry") f.deps.now = () => new Date("2026-10-12T00:00:00.000Z");
        else changed = true;
      }
      return result;
    };
    const start = f.provider.calls.length,
      result = await f.create().execute(f.request);
    assert.equal(f.provider.calls.length, start, mode);
    assert.equal(result.state, "refused-before-call", mode);
  }
});

test("missing and asynchronous current ownership assertions refuse guarded dispatch", async () => {
  for (const mode of ["missing", "async", "thenable", "throw"] as const) {
    const f = await fixture();
    if (mode === "missing")
      delete (f.deps.ownership as Partial<typeof f.deps.ownership>).assertCurrent;
    else
      f.deps.ownership.assertCurrent =
        mode === "async"
          ? async () => {}
          : mode === "thenable"
            ? () => ({
                then(resolve: () => void) {
                  resolve();
                },
              })
            : () => {
                throw Error("current fence unavailable");
              };
    const result = await f.create().execute(f.request);
    assert.equal(result.state, "refused-before-call", mode);
    assert.equal(f.provider.calls.length, 1, mode);
    assert.equal((await f.h.journal.read()).entries.length, 1, mode);
  }
});

test("fresh async ownership renewal cannot extend the original pinned owner expiry", async () => {
  const f = await fixture(),
    owner = await f.deps.ownership.require();
  let owners = 0,
    time = "2026-10-10T01:00:00.000Z";
  f.deps.now = () => new Date(time);
  f.deps.ownership.require = async () => ({
    ...owner,
    expiresAt: ++owners > 2 ? "2027-01-01T00:00:00.000Z" : "2026-10-10T02:00:00.000Z",
  });
  f.deps.ownership.assertCurrent = (binding, expected) => {
    assert.equal(binding.ledgerFile, owner.ledgerFile);
    assert.equal(expected.fence, owner.fence);
    assert.equal(expected.expiresAt, "2026-10-10T02:00:00.000Z");
    time = "2026-10-10T03:00:00.000Z";
  };
  const result = await f.create().execute(f.request);
  assert.equal(result.state, "refused-before-call");
  assert.equal(f.provider.calls.length, 1);
  assert.equal((await f.h.journal.read()).entries.length, 1);
});
