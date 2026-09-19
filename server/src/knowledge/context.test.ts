import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KnowledgeContext } from "@argus/contracts";
import {
  CONTEXT_MAX_CLAIMS,
  KnowledgeContextError,
  compareSuppliedConsumed,
  effectiveContextSpec,
  formatSelector,
  parseKnowledgeContextSpec,
  readKnowledgeContext,
  resolveKnowledgeContext,
  serializeKnowledgeContext,
  sha256Hex,
  writeKnowledgeContextFile,
} from "./context.js";
import {
  addClaim,
  addEvidence,
  addJustification,
  emptyLedger,
  reviseClaim,
  type KnowledgeLedger,
} from "./kernel.js";
import { applyKnowledgeDeltas, validateKnowledgeDelta } from "./delta.js";

/**
 * The pure half of controlled semantic context delivery: what a selector
 * means, what it resolves to against one snapshot, what the agent-facing
 * projection contains (and does not), and that the same snapshot always
 * yields the same bytes and hash.
 */

const T0 = "2026-09-19T10:00:00.000Z";
const v = (id: string, revision: number) => ({ id, revision });

function refuses(fn: () => unknown, code: string, pattern: RegExp) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof KnowledgeContextError, `expected KnowledgeContextError, got ${e}`);
    assert.equal(e.code, code);
    assert.match(e.message, pattern);
    return;
  }
  assert.fail("expected a refusal");
}

/** RULE-17:v1 (superseded by v2), CONSTRAINT-4:v1, ASSUME-9:v1 (unsupported),
 *  FACT-2:v1 (contested), DECISION-3:v1 derived from RULE-17:v2. */
function ledger(): KnowledgeLedger {
  let l = emptyLedger();
  l = addClaim(
    l,
    { id: "RULE-17", kind: "business-rule", statement: "Comment max is 180" },
    T0,
  ).ledger;
  l = addEvidence(
    l,
    {
      id: "EV-1",
      claim: v("RULE-17", 1),
      direction: "supports",
      source: { type: "document", uri: "spec://kobra/4.1" },
      note: "Kobra 4.1 spec",
    },
    T0,
  ).ledger;
  l = reviseClaim(
    l,
    { id: "RULE-17", statement: "Comment max is 500", revisionNote: "Kobra 4.2 raised the limit" },
    T0,
  ).ledger;
  l = addEvidence(
    l,
    {
      id: "EV-2",
      claim: v("RULE-17", 2),
      direction: "supports",
      source: { type: "document", uri: "spec://kobra/4.2" },
    },
    T0,
  ).ledger;
  l = addClaim(
    l,
    {
      id: "CONSTRAINT-4",
      kind: "constraint",
      statement: "Validation runs server-side",
      structuredValue: { where: "server" },
      producedBy: { instanceId: "inst-0", phaseId: "plan", runId: "run-0" },
    },
    T0,
  ).ledger;
  l = addEvidence(
    l,
    {
      id: "EV-3",
      claim: v("CONSTRAINT-4", 1),
      direction: "supports",
      source: { type: "human", who: "architect" },
    },
    T0,
  ).ledger;
  l = addClaim(
    l,
    { id: "ASSUME-9", kind: "assumption", statement: "Comments are plain text" },
    T0,
  ).ledger;
  l = addClaim(l, { id: "FACT-2", kind: "fact", statement: "Kobra strips HTML" }, T0).ledger;
  l = addEvidence(
    l,
    {
      id: "EV-4",
      claim: v("FACT-2", 1),
      direction: "supports",
      source: { type: "human", who: "a" },
    },
    T0,
  ).ledger;
  l = addEvidence(
    l,
    {
      id: "EV-5",
      claim: v("FACT-2", 1),
      direction: "opposes",
      source: { type: "human", who: "b" },
    },
    T0,
  ).ledger;
  l = addClaim(l, { id: "DECISION-3", kind: "decision", statement: "Validate at 500" }, T0).ledger;
  l = addJustification(
    l,
    {
      id: "J-1",
      conclusion: v("DECISION-3", 1),
      premises: [v("RULE-17", 2)],
      direction: "supports",
    },
    T0,
  ).ledger;
  return l;
}

// ── Spec parsing ────────────────────────────────────────────────────────────

test("spec: strings and objects normalize to the object form; bare id means active", () => {
  const spec = parseKnowledgeContextSpec({
    claims: [
      "RULE-17:v2",
      "CONSTRAINT-4",
      { id: "FACT-2", revision: 1 },
      { id: "ASSUME-9", revision: "active" },
    ],
  });
  assert.deepEqual(spec, {
    claims: [
      { id: "RULE-17", revision: 2 },
      { id: "CONSTRAINT-4", revision: "active" },
      { id: "FACT-2", revision: 1 },
      { id: "ASSUME-9", revision: "active" },
    ],
  });
  assert.equal(formatSelector(spec.claims[0]), "RULE-17:v2");
  assert.equal(formatSelector(spec.claims[1]), "CONSTRAINT-4 (active)");
});

test("spec: malformed selectors are refused deterministically, naming the entry", () => {
  refuses(() => parseKnowledgeContextSpec(null), "spec", /must be an object/);
  refuses(() => parseKnowledgeContextSpec({}), "spec", /claims must be a list/);
  refuses(() => parseKnowledgeContextSpec({ claims: [] }), "spec", /at least one claim/);
  refuses(
    () => parseKnowledgeContextSpec({ claims: ["x"], tags: [] }),
    "spec",
    /unknown key "tags"/,
  );
  refuses(
    () => parseKnowledgeContextSpec({ claims: ["RULE-17:v0"] }),
    "spec",
    /claims\[0\] must be a claim id/,
  );
  refuses(() => parseKnowledgeContextSpec({ claims: ["has space"] }), "spec", /claims\[0\]/);
  refuses(
    () => parseKnowledgeContextSpec({ claims: [42] }),
    "spec",
    /claims\[0\] must be a string or an object/,
  );
  refuses(
    () => parseKnowledgeContextSpec({ claims: [{ id: "RULE-17" }] }),
    "spec",
    /revision must be a positive integer or "active"/,
  );
  refuses(
    () => parseKnowledgeContextSpec({ claims: [{ id: "RULE-17", revision: 1.5 }] }),
    "spec",
    /revision must be/,
  );
  refuses(
    () => parseKnowledgeContextSpec({ claims: [{ id: "RULE-17", revision: "latest" }] }),
    "spec",
    /revision must be/,
  );
  refuses(
    () => parseKnowledgeContextSpec({ claims: [{ id: "RULE-17", revision: 1, kind: "x" }] }),
    "spec",
    /unknown key "kind"/,
  );
  refuses(
    () => parseKnowledgeContextSpec({ claims: [{ id: "bad id", revision: 1 }] }),
    "spec",
    /\.id must be a claim id/,
  );
  refuses(
    () =>
      parseKnowledgeContextSpec({
        claims: Array.from({ length: CONTEXT_MAX_CLAIMS + 1 }, (_, i) => `C-${i}`),
      }),
    "spec",
    /at most 64/,
  );
});

test("spec: the same claim id twice — exact+exact, exact+active or active+active — is refused", () => {
  for (const claims of [
    ["RULE-17:v2", "RULE-17:v2"],
    ["RULE-17:v1", "RULE-17:v2"],
    ["RULE-17:v2", "RULE-17"],
    ["RULE-17", { id: "RULE-17", revision: "active" }],
  ]) {
    refuses(
      () => parseKnowledgeContextSpec({ claims }),
      "spec",
      /claims\[1\]: RULE-17 is already selected by claims\[0\]; each claim id may appear once/,
    );
  }
});

test("effective spec: a step's replaces its phase's; absent on both is none", () => {
  const phase = { knowledgeContext: { claims: [{ id: "A", revision: 1 as const }] } };
  const step = { knowledgeContext: { claims: [{ id: "B", revision: "active" as const }] } };
  assert.deepEqual(effectiveContextSpec(phase, {}), phase.knowledgeContext);
  assert.deepEqual(effectiveContextSpec(phase, step), step.knowledgeContext);
  assert.deepEqual(effectiveContextSpec({}, step), step.knowledgeContext);
  assert.equal(effectiveContextSpec({}, {}), null);
});

// ── Resolution ──────────────────────────────────────────────────────────────

test("exact selector: RULE-17:v2 is supplied exactly, with its derived state and evidence", () => {
  const { context, supplied } = resolveKnowledgeContext(
    ledger(),
    parseKnowledgeContextSpec({ claims: ["RULE-17:v2"] }),
    T0,
  );
  assert.deepEqual(supplied, [v("RULE-17", 2)]);
  assert.equal(context.schemaVersion, 1);
  assert.equal(context.generatedAt, T0);
  assert.deepEqual(context.claims, [
    {
      ref: "RULE-17:v2",
      id: "RULE-17",
      revision: 2,
      kind: "business-rule",
      statement: "Comment max is 500",
      lifecycle: "active",
      support: "supported",
      revisionNote: "Kobra 4.2 raised the limit",
      evidence: [{ direction: "supports", source: { type: "document", uri: "spec://kobra/4.2" } }],
    },
  ]);
  assert.deepEqual(context.metadata?.selection, [
    { selector: { id: "RULE-17", revision: 2 }, resolved: v("RULE-17", 2) },
  ]);
});

test("active selector: resolves to the active revision at resolution time and records the exact revision", () => {
  const { context, supplied } = resolveKnowledgeContext(
    ledger(),
    parseKnowledgeContextSpec({ claims: ["RULE-17"] }),
    T0,
  );
  assert.deepEqual(supplied, [v("RULE-17", 2)]);
  assert.equal(context.claims[0].ref, "RULE-17:v2");
  assert.deepEqual(context.metadata?.selection, [
    { selector: { id: "RULE-17", revision: "active" }, resolved: v("RULE-17", 2) },
  ]);
  // "active" is a selector word, never a revision in the projection.
  assert.ok(context.claims.every((c) => typeof c.revision === "number"));
  assert.ok(supplied.every((r) => typeof r.revision === "number"));
});

test("active selector is a function of the snapshot: a later revision does not change an earlier resolution", () => {
  const before = ledger();
  const spec = parseKnowledgeContextSpec({ claims: ["RULE-17"] });
  const first = resolveKnowledgeContext(before, spec, T0);
  const after = reviseClaim(before, { id: "RULE-17", statement: "Comment max is 1000" }, T0).ledger;
  const second = resolveKnowledgeContext(after, spec, T0);
  assert.deepEqual(first.supplied, [v("RULE-17", 2)]);
  assert.deepEqual(second.supplied, [v("RULE-17", 3)]);
  // The earlier document is what it was: same bytes, same hash.
  assert.equal(resolveKnowledgeContext(before, spec, T0).sha256, first.sha256);
  assert.notEqual(second.sha256, first.sha256);
});

test("superseded historical exact revision: v1 is supplied with lifecycle superseded and its supersessor", () => {
  const { context } = resolveKnowledgeContext(
    ledger(),
    parseKnowledgeContextSpec({ claims: ["RULE-17:v1"] }),
    T0,
  );
  const [c] = context.claims;
  assert.equal(c.ref, "RULE-17:v1");
  assert.equal(c.statement, "Comment max is 180");
  assert.equal(c.lifecycle, "superseded");
  assert.equal(c.supersededBy, "RULE-17:v2");
  // Still supported on its own evidence: lifecycle and support are separate axes.
  assert.equal(c.support, "supported");
  assert.deepEqual(c.evidence, [
    {
      direction: "supports",
      source: { type: "document", uri: "spec://kobra/4.1" },
      note: "Kobra 4.1 spec",
    },
  ]);
});

test("unsupported and contested claims are supplied with their support state exposed, never hidden", () => {
  const { context } = resolveKnowledgeContext(
    ledger(),
    parseKnowledgeContextSpec({ claims: ["ASSUME-9", "FACT-2:v1"] }),
    T0,
  );
  assert.equal(context.claims[0].support, "unsupported");
  assert.equal("evidence" in context.claims[0], false);
  assert.equal(context.claims[1].support, "contested");
  assert.deepEqual(
    context.claims[1].evidence?.map((e) => e.direction),
    ["supports", "opposes"],
  );
});

test("projection carries structuredValue and producedBy when present, and nothing internal", () => {
  const { context, text } = resolveKnowledgeContext(
    ledger(),
    parseKnowledgeContextSpec({ claims: ["CONSTRAINT-4:v1", "DECISION-3"] }),
    T0,
  );
  assert.deepEqual(context.claims[0].structuredValue, { where: "server" });
  assert.deepEqual(context.claims[0].producedBy, {
    instanceId: "inst-0",
    phaseId: "plan",
    runId: "run-0",
  });
  // Not a serialized ledger: no record ids or timestamps, no justification
  // graph, no consumptions, no deltas, no unrelated claims.
  for (const forbidden of [
    '"createdAt"',
    '"EV-',
    '"J-1"',
    '"justifications"',
    '"consumptions"',
    '"deltas"',
    "RULE-17",
    "ASSUME-9",
  ]) {
    assert.equal(text.includes(forbidden), false, `projection must not contain ${forbidden}`);
  }
  const keys = Object.keys(context.claims[1]).sort();
  assert.deepEqual(keys, ["id", "kind", "lifecycle", "ref", "revision", "statement", "support"]);
});

test("unknown id and unknown revision refuse the whole context, naming the selector", () => {
  const l = ledger();
  refuses(
    () =>
      resolveKnowledgeContext(
        l,
        parseKnowledgeContextSpec({ claims: ["RULE-17:v2", "NOPE-1"] }),
        T0,
      ),
    "unknown-claim",
    /claims\[1\] \(NOPE-1 \(active\)\): claim NOPE-1 does not exist/,
  );
  refuses(
    () => resolveKnowledgeContext(l, parseKnowledgeContextSpec({ claims: ["RULE-17:v9"] }), T0),
    "unknown-revision",
    /claims\[0\] \(RULE-17:v9\): revision v9 of RULE-17 does not exist/,
  );
  refuses(
    () =>
      resolveKnowledgeContext(
        emptyLedger(),
        parseKnowledgeContextSpec({ claims: ["RULE-17"] }),
        T0,
      ),
    "unknown-claim",
    /RULE-17 does not exist/,
  );
});

test("determinism: the same snapshot and spec produce identical bytes and hash; order follows the spec", () => {
  const l = ledger();
  const spec = parseKnowledgeContextSpec({ claims: ["CONSTRAINT-4:v1", "RULE-17"] });
  const a = resolveKnowledgeContext(l, spec, T0);
  const b = resolveKnowledgeContext(structuredClone(l), spec, T0);
  assert.equal(a.text, b.text);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, sha256Hex(a.text));
  assert.equal(a.text, serializeKnowledgeContext(a.context));
  assert.ok(a.text.endsWith("\n"));
  assert.deepEqual(
    a.context.claims.map((c) => c.ref),
    ["CONSTRAINT-4:v1", "RULE-17:v2"],
  );
  const reversed = resolveKnowledgeContext(
    l,
    parseKnowledgeContextSpec({ claims: ["RULE-17", "CONSTRAINT-4:v1"] }),
    T0,
  );
  assert.deepEqual(
    reversed.context.claims.map((c) => c.ref),
    ["RULE-17:v2", "CONSTRAINT-4:v1"],
  );
});

// ── Supplied vs consumed ────────────────────────────────────────────────────

test("compareSuppliedConsumed: the three sets, deduplicated, in supplied then consumed order", () => {
  const cmp = compareSuppliedConsumed(
    [v("A", 1), v("B", 1), v("A", 1)],
    [v("B", 1), v("C", 2), v("C", 2)],
  );
  assert.deepEqual(cmp, {
    suppliedAndConsumed: [v("B", 1)],
    suppliedNotConsumed: [v("A", 1)],
    consumedNotSupplied: [v("C", 2)],
  });
  assert.deepEqual(compareSuppliedConsumed([], []), {
    suppliedAndConsumed: [],
    suppliedNotConsumed: [],
    consumedNotSupplied: [],
  });
});

test("applyKnowledgeDeltas classifies each consumed entry against the proposal's supplied set, and adds no consumption for a supplied-only claim", () => {
  const l = ledger();
  const mint = (() => {
    let n = 0;
    return (p: string) => `${p}-${++n}`;
  })();
  const { ledger: next, results } = applyKnowledgeDeltas(
    l,
    [
      {
        id: "KD-1",
        delta: validateKnowledgeDelta({ schemaVersion: 1, consumed: ["RULE-17:v2", "FACT-2:v1"] }),
        execution: { runId: "run-1", instanceId: "i", phaseId: "p" },
        attempt: 0,
        supplied: [v("RULE-17", 2), v("CONSTRAINT-4", 1)],
      },
    ],
    { now: T0, mint },
  );
  assert.deepEqual(
    next.consumptions.map((c) => [c.claim.id, c.source]),
    [
      ["RULE-17", "supplied-context"],
      ["FACT-2", "agent-discovered"],
    ],
  );
  // CONSTRAINT-4 was supplied and not consumed: no edge, anywhere.
  assert.equal(
    next.consumptions.some((c) => c.claim.id === "CONSTRAINT-4"),
    false,
  );
  assert.equal(results[0].consumptions[1].source, "agent-discovered");

  // No supplied set known (no invocation record): no classification.
  const { ledger: unknown } = applyKnowledgeDeltas(
    l,
    [
      {
        id: "KD-2",
        delta: validateKnowledgeDelta({ schemaVersion: 1, consumed: ["RULE-17:v2"] }),
        execution: { runId: "run-2" },
        attempt: 0,
      },
    ],
    { now: T0, mint },
  );
  assert.equal("source" in unknown.consumptions[0], false);

  // An empty supplied set (a run launched with no context) is knowledge too:
  // everything it consumed, it discovered.
  const { ledger: none } = applyKnowledgeDeltas(
    l,
    [
      {
        id: "KD-3",
        delta: validateKnowledgeDelta({ schemaVersion: 1, consumed: ["RULE-17:v2"] }),
        execution: { runId: "run-3" },
        attempt: 0,
        supplied: [],
      },
    ],
    { now: T0, mint },
  );
  assert.equal(none.consumptions[0].source, "agent-discovered");
});

// ── The file ────────────────────────────────────────────────────────────────

test("writeKnowledgeContextFile writes the exact bytes read-only, and readKnowledgeContext reads them back", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-context-"));
  const file = path.join(dir, "knowledge-context.json");
  const { text, context } = resolveKnowledgeContext(
    ledger(),
    parseKnowledgeContextSpec({ claims: ["RULE-17:v2"] }),
    T0,
  );
  await writeKnowledgeContextFile(file, text);
  assert.equal(readFileSync(file, "utf8"), text);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o444);
  }
  const back = (await readKnowledgeContext(file)) as KnowledgeContext;
  assert.deepEqual(back, context);
  assert.equal(await readKnowledgeContext(path.join(dir, "missing.json")), null);
});
