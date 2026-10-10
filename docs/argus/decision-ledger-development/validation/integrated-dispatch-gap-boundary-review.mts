import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { createEvaluationCoordinator } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/evaluationCoordinator.ts";
import { InvocationLedger } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/invocationLedger.ts";
import { harness, tempRoot, RESIDUAL_P } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/testSupport.ts";
import { createMockProvider } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/providers/mock.ts";
import { canonicalDigest } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/canonical.ts";
import { h2Harness } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/h2/testSupport.ts";

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
  const reservations = new Map<string, import("file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/invocationLedger.ts").Reservation>();
  const settlements = new Map<string, import("file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/invocationLedger.ts").InvocationSettlement>();
  const owner = {
    identity: "fixture",
    fence: "1",
    expiresAt,
    ledgerFile: "",
    scope: "fixture",
    policyDigest: d,
  };
  const ownership = {
    assertCurrent: (binding, expected) => {
      assert.equal(owner.ledgerFile, binding.ledgerFile);
      assert.equal(owner.scope, binding.scope);
      assert.equal(owner.policyDigest, binding.policyDigest);
      assert.equal(owner.identity, expected.identity);
      assert.equal(owner.fence, expected.fence);
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
  const gate: import("file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/evaluationCoordinator.ts").SharedEvaluationGate = {
    acquire: async (b: import("file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/evaluationCoordinator.ts").AdmissionBinding) => {
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
      r: import("file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/invocationLedger.ts").Reservation,
      s: import("file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/invocationLedger.ts").InvocationSettlement,
    ) => {
      settlements.set(r.invocationId, s);
    },
    cancelProvenUncalled: async (r: import("file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/invocationLedger.ts").Reservation) => {
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
      authorize: async (b: import("file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/evaluationCoordinator.ts").AdmissionBinding) => {
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
      check: async (b: import("file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/evaluationCoordinator.ts").AdmissionBinding) => {
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
import { createAnalysisRunner } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/sources/analysis.ts";
const f = await fixture(), h = h2Harness();
const parent = await h.service.assess({question:"run.failure-cause.residual",subject:{kind:"run",runId:"run-1"},provider:"claude-cli"});
assert.ok(parent.ok);
let spawns=0, observedExpired=false, coordinatorTime="2026-10-10T01:00:00.000Z";
const runner=createAnalysisRunner({
 enabled:()=>true,
 blocked:async()=>{await Promise.resolve(); coordinatorTime="2026-10-12T01:00:00.000Z"; observedExpired=true; return false;},
 meter:async()=>{},
 spawn:()=>{spawns++; return {kill(){},done:Promise.resolve({code:0,stdout:JSON.stringify({result:JSON.stringify({p:RESIDUAL_P}),total_cost_usd:0.1}),error:null})};}
});
h.runner.run=runner.run; h.runner.runWithAdmission=runner.runWithAdmission;
const journalEntriesBefore=(await h.journal.read()).entries.length;
const result=await createEvaluationCoordinator({...f.deps,now:()=>new Date(coordinatorTime),service:h.service,journal:h.journal}).execute({...f.request,assessmentId:parent.assessment.id,provider:"claude-cli"});
console.log(JSON.stringify({observedExpired,spawns,result},null,2));
assert.equal(spawns,0,"expired authorization must refuse at actual spawn boundary");


assert.equal((await h.journal.read()).entries.length,journalEntriesBefore,"proven dispatch refusal must not append assessment");
