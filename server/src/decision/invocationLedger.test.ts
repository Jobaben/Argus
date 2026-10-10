import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import {
  InvocationLedger,
  boundRequestDigest,
  type InvocationIntent,
  TERMINAL_RESERVE_BYTES,
} from "./invocationLedger.js";
import { canonicalDigest } from "./canonical.js";
import { tempRoot } from "./testSupport.js";
import { encodeLine } from "./storage.js";
export function intent(n = 1): InvocationIntent {
  const d = "a".repeat(64);
  const p = {
    format: "argus.retained-evaluation-preparation" as const,
    formatVersion: 1 as const,
    assessmentId: "DA-parent000001",
    parent: { digest: d, segment: "seg-00000001", line: 2 },
    question: { id: "question", version: 1, digest: d },
    projection: { id: "projection", version: 1, digest: d },
    snapshot: { sha256: d, bytes: 10, subject: { kind: "run" as const, runId: "run-1" } },
    providerKey: "mock",
    provider: {
      provider: "mock" as const,
      requestedModel: null,
      adapterVersion: 1,
      elicitation: "verbalized" as const,
    },
    sample: 0,
  };
  const i: InvocationIntent = {
    format: "argus.evaluation-intent",
    formatVersion: 1,
    invocationId: `IV-${n}`,
    namespace: "test",
    key: `key-${n}`,
    requestDigest: d,
    resultId: `DA-result${String(n).padStart(6, "0")}`,
    preparation: { ...p, digest: canonicalDigest(p).sha256 },
    authorization: {
      reference: "auth",
      digest: d,
      principal: "operator",
      scope: "test",
      issuedAt: "2026-10-10T00:00:00.000Z",
      expiresAt: "2026-10-11T00:00:00.000Z",
      invocationId: `IV-${n}`,
      requestDigest: d,
      reportedModels: null,
    },
    preflight: {
      reference: "support",
      digest: d,
      invocationId: `IV-${n}`,
      requestDigest: d,
      expiresAt: "2026-10-11T00:00:00.000Z",
    },
    owner: {
      identity: "writer",
      fence: "1",
      expiresAt: "2026-10-11T00:00:00.000Z",
      ledgerFile: "fixture",
      scope: "test",
      policyDigest: d,
    },
    reservation: {
      id: `R-${n}`,
      invocationId: `IV-${n}`,
      requestDigest: d,
      scope: "test",
      policyDigest: d,
      allowanceUsd: 1,
    },
    createdAt: "2026-10-10T00:00:00.000Z",
  };
  sealRequest(i);
  return i;
}
function sealRequest(i: InvocationIntent) {
  i.requestDigest = boundRequestDigest(i);
  i.authorization.requestDigest = i.requestDigest;
  i.preflight.requestDigest = i.requestDigest;
  i.reservation.requestDigest = i.requestDigest;
}

const own = async () => undefined;
test("durable ordered settlements and permanent caller identities", async () => {
  const file = path.join(tempRoot(), "ledger.jsonl"),
    l = new InvocationLedger({ file, requireOwnership: own }),
    i = intent();
  const saved = await l.appendIntent(i);
  await l.appendSettlement({
    invocationId: i.invocationId,
    intentDigest: saved.digest,
    state: "unknown-outcome",
    resultId: i.resultId,
    resultDigest: null,
    actualProvider: null,
    outcome: null,
    providerCalled: "unknown",
    costUsd: null,
    reason: "restart",
    at: i.createdAt,
  });
  const state = await new InvocationLedger({ file, requireOwnership: own }).load();
  assert.equal(state.intents.size, 1);
  assert.equal(state.settlements.get(i.invocationId)?.state, "unknown-outcome");
  await assert.rejects(l.appendIntent(i), /duplicate/);
});
test("restart reserves terminal capacity for every durable open intent", async () => {
  const file = path.join(tempRoot(), "ledger.jsonl"),
    opts = { file, requireOwnership: own, maxBytes: TERMINAL_RESERVE_BYTES * 2 + 10000 };
  const l = new InvocationLedger(opts);
  await l.appendIntent(intent(1));
  await l.appendIntent(intent(2));
  await assert.rejects(new InvocationLedger(opts).reserveCapacity(intent(3)), /capacity/);
});
test("damage halts admission and preserves original bytes", async () => {
  for (const damage of ["torn", "bad", "hash", "gap", "transition", "extra"]) {
    const file = path.join(tempRoot(), "ledger.jsonl"),
      l = new InvocationLedger({ file, requireOwnership: own });
    await l.appendIntent(intent());
    if (damage === "torn") await appendFile(file, "{");
    if (damage === "bad") await appendFile(file, "invalid\n");
    if (damage === "hash")
      await writeFile(file, (await readFile(file, "utf8")).replace("operator", "tampered"));
    if (["gap", "transition", "extra"].includes(damage)) {
      const env = JSON.parse(await readFile(file, "utf8"));
      env.body.seq = damage === "gap" ? 3 : 2;
      env.body.previous = env.sha256;
      if (damage === "extra") env.body.unexpected = true;
      await appendFile(file, encodeLine(env.kind, env.body).text);
    }
    const before = await readFile(file);
    await assert.rejects(l.load(), /integrity/);
    await assert.rejects(l.appendIntent(intent(2)), /integrity/);
    assert.deepEqual(await readFile(file), before);
  }
});

test("closed schemas reject unknown fields and all result and caller identity collisions", async () => {
  const file = path.join(tempRoot(), "ledger.jsonl"),
    l = new InvocationLedger({ file, requireOwnership: own });
  await l.appendIntent(intent());
  for (const changed of [
    { ...intent(2), resultId: intent().resultId },
    { ...intent(2), key: intent().key },
    { ...intent(2), invocationId: intent().invocationId },
    { ...intent(2), unexpected: true },
  ])
    await assert.rejects(l.appendIntent(changed), /duplicate|integrity/);
  for (const kind of ["rule-verification", "acceptance-verification"] as const) {
    const i = intent(kind === "rule-verification" ? 3 : 4);
    i.preparation.snapshot.subject = { kind, verificationId: "verification" };
    const { digest: old, ...rest } = i.preparation;
    void old;
    i.preparation.digest = canonicalDigest(rest).sha256;
    sealRequest(i);
    await l.appendIntent(i);
  }
  assert.equal((await l.load()).intents.size, 3);
});
test("uncertain terminal states cannot falsely claim proven no call", async () => {
  for (const state of ["unknown-outcome", "integrity-halt"] as const) {
    const l = new InvocationLedger({
        file: path.join(tempRoot(), "ledger.jsonl"),
        requireOwnership: own,
      }),
      saved = await l.appendIntent(intent());
    await assert.rejects(
      l.appendSettlement({
        invocationId: saved.intent.invocationId,
        intentDigest: saved.digest,
        state,
        resultId: saved.intent.resultId,
        resultDigest: null,
        actualProvider: null,
        outcome: null,
        providerCalled: "no",
        costUsd: null,
        reason: "uncertain",
        at: saved.intent.createdAt,
      }),
      /integrity/,
    );
  }
});
