import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { StoredSnapshot } from "@argus/contracts";
import { canonicalDigest } from "../canonical.js";
import { DecisionJournal } from "../journal.js";
import { createMockProvider } from "../providers/mock.js";
import { createDecisionService } from "../service.js";
import { memorySources, tempRoot } from "../testSupport.js";
import { GATE_REVIEW_V1, H1_BUILDERS, h1Registry } from "./definitions.js";
import { projectGateReview } from "./projection.js";
import { gateInstance, gateRun, reviewOf } from "./testSupport.js";

/**
 * `service.assessSnapshot`: a call on the snapshot captured while the gate
 * was eligible (RFC §Q.3). The snapshot is re-sealed and must match its
 * digest, the question's registered projection and the subject, or the
 * provider is never called.
 */

function setup() {
  const root = tempRoot("argus-h1-svc-");
  const registry = h1Registry();
  const journal = new DecisionJournal({ root: path.join(root, "decisions") });
  const mock = createMockProvider({ script: () => ({ distribution: 0.7 }) });
  const service = createDecisionService({
    journal,
    registry,
    builders: H1_BUILDERS,
    sources: memorySources().sources,
    providers: { mock },
  });
  const inst = gateInstance();
  const built = projectGateReview(registry.projection("gate-review", 1)!.ref, GATE_REVIEW_V1, {
    instance: inst,
    phase: inst.phases[0],
    phaseDef: inst.definition!.phases[0],
    review: { ok: true, review: reviewOf(inst, "publish") },
    runs: new Map([["run-a", gateRun("run-a")]]),
    watchtower: null,
    changes: {
      files: { status: "unavailable", reason: "none" },
      diffStat: { status: "unavailable", reason: "none" },
      repository: null,
    },
  });
  assert.ok(built.ok);
  return { journal, mock, service, snapshot: (built as { snapshot: StoredSnapshot }).snapshot };
}

const req = (snapshot: StoredSnapshot) => ({
  question: "gate.operator-action",
  version: 1,
  snapshot,
  provider: "mock",
  id: "DA-svc-000001",
});

test("the captured snapshot is published and assessed as is, in shadow mode", async () => {
  const { journal, mock, service, snapshot } = setup();
  const res = await service.assessSnapshot(req(snapshot));
  assert.ok(res.ok);
  assert.equal(res.assessment.snapshot.sha256, snapshot.sha256);
  assert.equal(res.assessment.mode, "shadow");
  assert.deepEqual(res.assessment.subject, {
    kind: "phase-attempt",
    instanceId: "inst-1",
    phaseId: "publish",
    attempt: 0,
  });
  assert.equal(mock.calls.length, 1);
  const lookup = await journal.loadSnapshot(snapshot.sha256);
  assert.equal(lookup.status, "retained");
});

test("a tampered, re-stamped or foreign snapshot is refused before any call", async () => {
  const { mock, service, snapshot } = setup();
  const tampered: StoredSnapshot = {
    ...snapshot,
    content: { ...snapshot.content, subjectAuthored: [] },
  };
  const a = await service.assessSnapshot(req(tampered));
  assert.equal(!a.ok && a.reason, "snapshot-unbuildable");

  const content = {
    ...snapshot.content,
    projection: { ...snapshot.content.projection, digest: "0".repeat(64) },
  };
  const sealed = canonicalDigest(content);
  const b = await service.assessSnapshot(
    req({ sha256: sealed.sha256, bytes: sealed.bytes, content }),
  );
  assert.equal(!b.ok && b.reason, "definition-mismatch");

  const runContent = { ...snapshot.content, subject: { kind: "run" as const, runId: "run-a" } };
  const r = canonicalDigest(runContent);
  const c = await service.assessSnapshot(
    req({ sha256: r.sha256, bytes: r.bytes, content: runContent }),
  );
  assert.equal(!c.ok && c.reason, "subject-mismatch");

  assert.equal(mock.calls.length, 0);
  assert.ok([a, b, c].every((x) => !x.ok && x.providerCalled === false));
});

test("the live gate-review builder refuses: an H1 snapshot is never rebuilt at call time", async () => {
  const { mock, service } = setup();
  const res = await service.assess({
    question: "gate.operator-action",
    version: 1,
    subject: { kind: "phase-attempt", instanceId: "inst-1", phaseId: "publish", attempt: 0 },
    provider: "mock",
  });
  assert.equal(!res.ok && res.reason, "snapshot-unbuildable");
  assert.equal(mock.calls.length, 0);
});
