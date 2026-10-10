import { writeFileSync } from "node:fs";
import path from "node:path";
import { h2Harness } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/h2/testSupport.ts";
import { tempRoot } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/testSupport.ts";
import { createEvaluationCoordinator } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/evaluationCoordinator.ts";
import { InvocationLedger } from "file:///C:/Users/ushab/.codex/worktrees/decision-ledger-foundations-h2/Argus/server/src/decision/invocationLedger.ts";
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
if (!parent.ok) throw Error("no parent");
writeFileSync(path.join(h.root, "provider-cwd", "unsafe"), "x");
const baseline = runnerCalls;
const now = () => new Date("2026-10-10T01:00:00.000Z"),
  expiresAt = "2026-10-11T00:00:00.000Z",
  digest = "a".repeat(64);
const owner = {
  identity: "probe",
  fence: "1",
  expiresAt,
  ledgerFile: "",
  scope: "probe",
  policyDigest: digest,
};
const ledger = new InvocationLedger({
  file: path.join(tempRoot(), "invocations.jsonl"),
  requireOwnership: async () => {},
});
owner.ledgerFile = ledger.file;
const reservations = new Map(),
  settlements = new Map();
const gate = {
  acquire: async (b: any) => {
    if ([...settlements.values()].some((s: any) => s.providerCalled !== "no" && s.costUsd === null))
      throw Error("unknown spent cost");
    const r = {
      id: "R-" + b.invocationId,
      invocationId: b.invocationId,
      requestDigest: b.requestDigest,
      scope: b.scope,
      policyDigest: b.policyDigest,
      allowanceUsd: b.allowanceUsd,
    };
    reservations.set(b.invocationId, r);
    return r;
  },
  validate: async () => {},
  lookup: async (id: string) => reservations.get(id) ?? null,
  orphans: async () =>
    [...reservations.values()].filter((r: any) => !settlements.has(r.invocationId)),
  recoverOrphan: async () => null,
  settle: async (r: any, s: any) => {
    settlements.set(r.invocationId, s);
  },
  cancelProvenUncalled: async (r: any) => {
    reservations.delete(r.invocationId);
  },
};
const c = createEvaluationCoordinator({
  service: h.service,
  journal: h.journal,
  ledger,
  gate,
  ownership: { require: async () => owner },
  now,
  authorization: {
    authorize: async (b: any) => ({
      reference: "grant",
      digest,
      principal: "operator",
      scope: b.scope,
      issuedAt: "2026-10-10T00:00:00.000Z",
      expiresAt,
      invocationId: b.invocationId,
      requestDigest: b.requestDigest,
      reportedModels: null,
    }),
  },
  preflight: {
    check: async (b: any) => ({
      reference: "preflight",
      digest,
      expiresAt,
      invocationId: b.invocationId,
      requestDigest: b.requestDigest,
    }),
  },
});
const request = {
  namespace: "probe",
  key: "one",
  assessmentId: parent.assessment.id,
  provider: "claude-cli",
  sample: 0,
  scope: "probe",
  policyDigest: digest,
  allowanceUsd: 1,
};
console.log(
  "COORDINATOR",
  JSON.stringify({
    result: await c.execute(request),
    settlements: [...settlements.values()],
    extraRunnerCalls: runnerCalls - baseline,
    extraSpawns: h.spawns.length - 1,
  }),
);
console.log(
  "COORDINATOR_NEXT",
  JSON.stringify({
    result: await c.execute({ ...request, key: "two" }),
    extraRunnerCalls: runnerCalls - baseline,
    extraSpawns: h.spawns.length - 1,
  }),
);
