import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArtifactRef, ClaimKind, ClaimRef, ImpactPath, ImpactSet } from "@argus/contracts";
import {
  addClaim,
  addEvidence,
  addJustification,
  consumersOf,
  emptyLedger,
  evaluateSupport,
  executionProvenance,
  formatClaimRef,
  recordArtifact,
  recordConsumption,
  reviseClaim,
  transitiveDependentsOf,
  viewOf,
  type KnowledgeLedger,
} from "./kernel.js";
import { analyzeImpact } from "./impact.js";

/**
 * Impact analysis on hand-built ledgers. Each scenario named in the Phase 2
 * brief is a test here, so the meaning of "impacted" — changed support, not
 * reachability; consumers, not producers; exact revisions, never retargeted —
 * is pinned by name rather than by an operator's expectation.
 */

const T0 = "2026-09-19T10:00:00.000Z";
const T1 = "2026-09-19T10:01:00.000Z";

const v1 = (id: string): ClaimRef => ({ id, revision: 1 });
const v = (id: string, revision: number): ClaimRef => ({ id, revision });

class Build {
  ledger: KnowledgeLedger = emptyLedger();
  private n = 0;

  claim(
    id: string,
    kind: ClaimKind = "fact",
    opts: {
      statement?: string;
      producedBy?: { runId: string; instanceId?: string; phaseId?: string };
    } = {},
  ): this {
    this.ledger = addClaim(
      this.ledger,
      { id, kind, statement: opts.statement ?? `${id} holds`, producedBy: opts.producedBy },
      T0,
    ).ledger;
    return this;
  }
  evidence(claim: ClaimRef, direction: "supports" | "opposes" = "supports"): this {
    this.ledger = addEvidence(
      this.ledger,
      { id: `EV-${++this.n}`, claim, direction, source: { type: "human", who: "tester" } },
      T0,
    ).ledger;
    return this;
  }
  justify(
    premises: ClaimRef[],
    conclusion: ClaimRef,
    direction: "supports" | "opposes" = "supports",
    id = `J-${++this.n}`,
  ): this {
    this.ledger = addJustification(this.ledger, { id, conclusion, premises, direction }, T0).ledger;
    return this;
  }
  revise(id: string, statement: string): this {
    this.ledger = reviseClaim(this.ledger, { id, statement }, T1).ledger;
    return this;
  }
  consume(
    runId: string,
    claim: ClaimRef,
    locators: { instanceId?: string; phaseId?: string } = {},
  ): this {
    this.ledger = recordConsumption(
      this.ledger,
      { execution: { runId, ...locators }, claim },
      T0,
    ).ledger;
    return this;
  }
  produce(runId: string, artifact: ArtifactRef): this {
    this.ledger = recordArtifact(this.ledger, { execution: { runId }, artifact }, T0).ledger;
    return this;
  }
}

const refs = (list: ClaimRef[]) => list.map(formatClaimRef);
const claimIds = (set: ImpactSet) => refs(set.semantic.affectedClaims.map((c) => c.claim));
const runIds = (set: ImpactSet) => set.executions.map((e) => e.execution.runId);
/** A path rendered as `root -- via --> node -- via --> node`. */
function render(path: ImpactPath): string {
  return path.hops
    .map((h) => {
      const node =
        h.to.kind === "claim"
          ? formatClaimRef(h.to.claim)
          : h.to.kind === "execution"
            ? h.to.execution.runId
            : `${h.to.execution.runId}:${h.to.artifact.path}`;
      const via = h.justification ? `${h.via}(${h.justification})` : h.via;
      return `-- ${via} --> ${node}`;
    })
    .join(" ");
}
const pathFor = (set: ImpactSet, target: string) =>
  set.paths.find((p) => {
    const t = p.target;
    return t.kind === "claim"
      ? formatClaimRef(t.claim) === target
      : t.kind === "execution"
        ? t.execution.runId === target
        : `${t.execution.runId}:${t.artifact.path}` === target;
  });

// ── Semantic dependency only ────────────────────────────────────────────────

test("A → B → C, A superseded: B and C are affected, with premise reasons and paths", () => {
  const b = new Build()
    .claim("A")
    .claim("B", "conclusion")
    .claim("C", "decision")
    .evidence(v1("A"))
    .justify([v1("A")], v1("B"), "supports", "J-AB")
    .justify([v1("B")], v1("C"), "supports", "J-BC")
    .revise("A", "A, restated");

  const set = analyzeImpact(b.ledger, v1("A"));
  assert.deepEqual(set.root, {
    claim: v1("A"),
    lifecycle: "superseded",
    support: "supported",
    conditions: ["superseded"],
  });
  assert.deepEqual(claimIds(set), ["B:v1", "C:v1"]);
  assert.deepEqual(set.semantic.affectedClaims[0], {
    claim: v1("B"),
    reasons: ["premise-superseded"],
    support: { ifRootHeld: "supported", actual: "unsupported" },
  });
  assert.deepEqual(set.semantic.affectedClaims[1], {
    claim: v1("C"),
    reasons: ["premise-unsupported"],
    support: { ifRootHeld: "supported", actual: "unsupported" },
  });
  assert.deepEqual(
    set.semantic.affectedJustifications.map((j) => [j.id, j.inForce]),
    [
      ["J-AB", { ifRootHeld: true, actual: false }],
      ["J-BC", { ifRootHeld: true, actual: false }],
    ],
  );
  assert.deepEqual(set.executions, []);
  assert.deepEqual(set.artifacts, []);
  assert.equal(render(pathFor(set, "B:v1")!), "-- premise-of(J-AB) --> B:v1");
  assert.equal(
    render(pathFor(set, "C:v1")!),
    "-- premise-of(J-AB) --> B:v1 -- premise-of(J-BC) --> C:v1",
  );
});

test("an active, supported root impacts nothing", () => {
  const b = new Build()
    .claim("A")
    .claim("B")
    .evidence(v1("A"))
    .justify([v1("A")], v1("B"));
  const set = analyzeImpact(b.ledger, v1("A"));
  assert.deepEqual(set.root.conditions, []);
  assert.deepEqual(set.semantic, { affectedClaims: [], affectedJustifications: [] });
  assert.deepEqual(set.paths, []);
});

test("a root that lost evidential support is reported as unsupported, not superseded", () => {
  // A has no evidence at all; B rests on it.
  const b = new Build()
    .claim("A")
    .claim("B")
    .justify([v1("A")], v1("B"), "supports", "J-AB");
  const set = analyzeImpact(b.ledger, v1("A"));
  assert.deepEqual(set.root.conditions, ["unsupported"]);
  assert.equal(set.root.lifecycle, "active");
  assert.deepEqual(set.semantic.affectedClaims[0].reasons, ["premise-unsupported"]);
});

// ── Multiple independent justifications ─────────────────────────────────────

test("A → C and B → C: superseding A does not propagate through C while B holds", () => {
  const b = new Build()
    .claim("A")
    .claim("B")
    .claim("C", "conclusion")
    .claim("D", "decision")
    .evidence(v1("A"))
    .evidence(v1("B"))
    .justify([v1("A")], v1("C"), "supports", "J-A")
    .justify([v1("B")], v1("C"), "supports", "J-B")
    .justify([v1("C")], v1("D"), "supports", "J-CD")
    .consume("run-uses-C", v1("C"))
    .consume("run-uses-D", v1("D"))
    .consume("run-uses-A", v1("A"))
    .revise("A", "A, restated");

  // Reachability says C and D depend on A. Impact says neither changed.
  assert.deepEqual(refs(transitiveDependentsOf(b.ledger, v1("A"))), ["C:v1", "D:v1"]);
  assert.equal(evaluateSupport(b.ledger, v1("C")), "supported");

  const set = analyzeImpact(b.ledger, v1("A"));
  assert.deepEqual(claimIds(set), []);
  // The justification that lost force is still reported — it did change.
  assert.deepEqual(
    set.semantic.affectedJustifications.map((j) => j.id),
    ["J-A"],
  );
  // Only the run that consumed A:v1 itself is impacted; consumers of C and D
  // built on premises that still hold.
  assert.deepEqual(runIds(set), ["run-uses-A"]);
  assert.deepEqual(set.executions[0].consumed, [v1("A")]);
  assert.equal(render(pathFor(set, "run-uses-A")!), "-- consumed-by --> run-uses-A");

  // Now B goes too: C has nothing left, and everything downstream follows.
  b.revise("B", "B, restated");
  const again = analyzeImpact(b.ledger, v1("A"));
  assert.deepEqual(claimIds(again), ["C:v1", "D:v1"]);
  assert.deepEqual(runIds(again), ["run-uses-C", "run-uses-D", "run-uses-A"]);
});

// ── Consumer execution ──────────────────────────────────────────────────────

test("RULE-A → DECISION-B, consumed by RUN-1: the run is impacted, explained through the decision", () => {
  const b = new Build()
    .claim("RULE-A", "business-rule")
    .claim("DECISION-B", "decision")
    .evidence(v1("RULE-A"))
    .justify([v1("RULE-A")], v1("DECISION-B"), "supports", "J-1")
    .consume("RUN-1", v1("DECISION-B"), { instanceId: "inst-1", phaseId: "implement" })
    .revise("RULE-A", "the rule, restated");

  const set = analyzeImpact(b.ledger, v1("RULE-A"));
  assert.deepEqual(set.executions, [
    {
      execution: { runId: "RUN-1", instanceId: "inst-1", phaseId: "implement" },
      reasons: ["consumed-affected-claim"],
      consumed: [v1("DECISION-B")],
    },
  ]);
  assert.equal(
    render(pathFor(set, "RUN-1")!),
    "-- premise-of(J-1) --> DECISION-B:v1 -- consumed-by --> RUN-1",
  );
});

// ── Producer is not consumer ────────────────────────────────────────────────

test("RUN-A produced DECISION-B and RUN-B consumed it: only RUN-B is impacted", () => {
  const b = new Build()
    .claim("RULE-A", "business-rule")
    .claim("DECISION-B", "decision", {
      producedBy: { runId: "RUN-A", instanceId: "inst-1", phaseId: "plan" },
    })
    .evidence(v1("RULE-A"))
    .justify([v1("RULE-A")], v1("DECISION-B"), "supports", "J-1")
    .consume("RUN-B", v1("DECISION-B"), { instanceId: "inst-1", phaseId: "implement" });

  // Provenance is symmetric and unambiguous before anything changes.
  const producer = executionProvenance(b.ledger, "RUN-A")!;
  assert.deepEqual(
    refs(producer.produced.claims.map((c) => ({ id: c.id, revision: c.revision }))),
    ["DECISION-B:v1"],
  );
  assert.deepEqual(producer.consumed, []);
  const consumer = executionProvenance(b.ledger, "RUN-B")!;
  assert.deepEqual(consumer.produced.claims, []);
  assert.deepEqual(refs(consumer.consumed.map((c) => c.claim)), ["DECISION-B:v1"]);
  assert.equal(consumer.currency, "current");

  // The rule changes.
  b.revise("RULE-A", "the rule, restated");
  const set = analyzeImpact(b.ledger, v1("RULE-A"));
  assert.deepEqual(runIds(set), ["RUN-B"]);
  assert.ok(!runIds(set).includes("RUN-A"));
  // The producer is still visible — as provenance on the affected claim, not
  // as an impacted execution.
  assert.deepEqual(set.semantic.affectedClaims[0].producedBy, {
    runId: "RUN-A",
    instanceId: "inst-1",
    phaseId: "plan",
  });
  assert.equal(executionProvenance(b.ledger, "RUN-B")!.currency, "stale");
  assert.equal(executionProvenance(b.ledger, "RUN-A")!.currency, "current");

  // The same distinction when the decision itself is revised.
  b.revise("DECISION-B", "the decision, restated");
  const direct = analyzeImpact(b.ledger, v1("DECISION-B"));
  assert.deepEqual(direct.root.conditions, ["superseded", "unsupported"]);
  assert.deepEqual(runIds(direct), ["RUN-B"]);
});

// ── Execution → artifact ────────────────────────────────────────────────────

test("RULE-A → DECISION-B → RUN-1 → ARTIFACT-X: the artifact is impacted with a full path", () => {
  const b = new Build()
    .claim("RULE-A", "business-rule")
    .claim("DECISION-B", "decision")
    .evidence(v1("RULE-A"))
    .justify([v1("RULE-A")], v1("DECISION-B"), "supports", "J-1")
    .consume("RUN-1", v1("DECISION-B"))
    .produce("RUN-1", { location: "repository", path: "src/ARTIFACT-X.cs", gitHead: "abc1234" })
    .produce("RUN-1", { location: "artifact-dir", path: "report.md" })
    .revise("RULE-A", "the rule, restated");

  const set = analyzeImpact(b.ledger, v1("RULE-A"));
  assert.deepEqual(set.artifacts, [
    {
      execution: { runId: "RUN-1" },
      artifact: { location: "repository", path: "src/ARTIFACT-X.cs", gitHead: "abc1234" },
      reasons: ["produced-by-affected-execution"],
    },
    {
      execution: { runId: "RUN-1" },
      artifact: { location: "artifact-dir", path: "report.md" },
      reasons: ["produced-by-affected-execution"],
    },
  ]);
  assert.equal(
    render(pathFor(set, "RUN-1:src/ARTIFACT-X.cs")!),
    "-- premise-of(J-1) --> DECISION-B:v1 -- consumed-by --> RUN-1 -- produced --> RUN-1:src/ARTIFACT-X.cs",
  );
  // Paths: claims, then executions, then artifacts — one each.
  assert.deepEqual(
    set.paths.map((p) => p.target.kind),
    ["claim", "execution", "artifact", "artifact"],
  );
});

// ── Exact revision stability ────────────────────────────────────────────────

test("RUN-1 consumed RULE:v1; RULE:v2 supersedes it; RUN-1 stays on v1", () => {
  const b = new Build()
    .claim("RULE", "business-rule")
    .evidence(v1("RULE"))
    .consume("RUN-1", v1("RULE"))
    .revise("RULE", "the rule, restated");

  assert.deepEqual(
    b.ledger.consumptions.map((c) => formatClaimRef(c.claim)),
    ["RULE:v1"],
  );
  assert.deepEqual(
    consumersOf(b.ledger, v1("RULE")).map((c) => c.execution.runId),
    ["RUN-1"],
  );
  assert.deepEqual(consumersOf(b.ledger, v("RULE", 2)), []);

  const prov = executionProvenance(b.ledger, "RUN-1")!;
  assert.deepEqual(prov.consumed, [
    { claim: v1("RULE"), lifecycle: "superseded", support: "supported", current: false },
  ]);
  assert.equal(prov.currency, "stale");

  // Impact on v2 (active, no evidence yet → unsupported) reaches no consumer:
  // nobody has consumed v2.
  assert.deepEqual(runIds(analyzeImpact(b.ledger, v("RULE", 2))), []);
  assert.deepEqual(runIds(analyzeImpact(b.ledger, v1("RULE"))), ["RUN-1"]);
});

// ── Superseded but historically supported ───────────────────────────────────

test("a superseded revision can still be supported, and the impact reason is supersession", () => {
  const b = new Build()
    .claim("RULE-17", "business-rule", { statement: "Kobra customer comment max = 180" })
    .claim("CONCLUSION-8", "conclusion")
    .evidence(v1("RULE-17"))
    .justify([v1("RULE-17")], v1("CONCLUSION-8"), "supports", "J-1")
    .consume("run_456", v1("CONCLUSION-8"))
    .revise("RULE-17", "Kobra customer comment max = 500");

  const old = viewOf(b.ledger, b.ledger.claims[0]);
  assert.equal(old.lifecycle, "superseded");
  assert.equal(old.support, "supported");

  const set = analyzeImpact(b.ledger, v1("RULE-17"));
  assert.equal(set.root.support, "supported");
  assert.deepEqual(set.root.conditions, ["superseded"]);
  assert.deepEqual(set.semantic.affectedClaims[0].reasons, ["premise-superseded"]);
  assert.ok(!set.semantic.affectedClaims[0].reasons.includes("premise-unsupported"));
  assert.deepEqual(runIds(set), ["run_456"]);
});

// ── Contested premise ───────────────────────────────────────────────────────

test("a premise that becomes contested impacts its dependents and their consumers, as contested", () => {
  const b = new Build()
    .claim("P")
    .claim("C", "conclusion")
    .evidence(v1("P"))
    .justify([v1("P")], v1("C"), "supports", "J-1")
    .consume("RUN-1", v1("C"))
    .consume("RUN-2", v1("P"));
  assert.deepEqual(analyzeImpact(b.ledger, v1("P")).root.conditions, []);

  b.evidence(v1("P"), "opposes");
  const set = analyzeImpact(b.ledger, v1("P"));
  assert.deepEqual(set.root, {
    claim: v1("P"),
    lifecycle: "active",
    support: "contested",
    conditions: ["contested"],
  });
  assert.deepEqual(set.semantic.affectedClaims, [
    {
      claim: v1("C"),
      reasons: ["premise-contested"],
      support: { ifRootHeld: "supported", actual: "unsupported" },
    },
  ]);
  assert.deepEqual(runIds(set), ["RUN-1", "RUN-2"]);
  assert.equal(executionProvenance(b.ledger, "RUN-2")!.consumed[0].support, "contested");
  assert.equal(executionProvenance(b.ledger, "RUN-2")!.currency, "stale");
});

test("an opposing derivation losing force moves support up; a derivation gaining force is support-changed", () => {
  // A → P (supports), N → P (opposes): P is contested, so P → C carries nothing.
  const b = new Build()
    .claim("A")
    .claim("N")
    .claim("P", "conclusion")
    .claim("C", "decision")
    .evidence(v1("A"))
    .evidence(v1("N"))
    .justify([v1("A")], v1("P"), "supports")
    .justify([v1("N")], v1("P"), "opposes", "J-N")
    .justify([v1("P")], v1("C"), "supports", "J-PC")
    .consume("RUN-1", v1("P"))
    .consume("RUN-2", v1("C"));
  assert.equal(evaluateSupport(b.ledger, v1("P")), "contested");
  assert.equal(evaluateSupport(b.ledger, v1("C")), "unsupported");

  b.revise("N", "N, restated");
  const set = analyzeImpact(b.ledger, v1("N"));
  assert.deepEqual(set.semantic.affectedClaims, [
    {
      // The opposing derivation lost force on a superseded premise: the
      // mechanism is named, and the support pair carries the direction.
      claim: v1("P"),
      reasons: ["premise-superseded"],
      support: { ifRootHeld: "contested", actual: "supported" },
    },
    {
      // C's derivation *gained* force — no premise of it fails — so the only
      // honest reason is that its support changed.
      claim: v1("C"),
      reasons: ["support-changed"],
      support: { ifRootHeld: "unsupported", actual: "supported" },
    },
  ]);
  assert.deepEqual(
    set.semantic.affectedJustifications.map((j) => [j.id, j.inForce]),
    [
      ["J-N", { ifRootHeld: true, actual: false }],
      ["J-PC", { ifRootHeld: false, actual: true }],
    ],
  );
  // Both runs consumed a claim whose status changed, so both are reported —
  // with the direction of the change on the claim for the caller to judge.
  assert.deepEqual(runIds(set), ["RUN-1", "RUN-2"]);
  assert.equal(
    render(pathFor(set, "RUN-2")!),
    "-- premise-of(J-N) --> P:v1 -- premise-of(J-PC) --> C:v1 -- consumed-by --> RUN-2",
  );
});

// ── Independent execution ───────────────────────────────────────────────────

test("a run in the same instance and phase with no semantic dependency is not impacted", () => {
  const b = new Build()
    .claim("RULE-A", "business-rule")
    .claim("OTHER")
    .claim("DECISION-B", "decision")
    .evidence(v1("RULE-A"))
    .evidence(v1("OTHER"))
    .justify([v1("RULE-A")], v1("DECISION-B"))
    .consume("RUN-1", v1("DECISION-B"), { instanceId: "inst-1", phaseId: "implement" })
    .consume("RUN-2", v1("OTHER"), { instanceId: "inst-1", phaseId: "implement" })
    .produce("RUN-2", { location: "repository", path: "src/Unrelated.cs" })
    .revise("RULE-A", "the rule, restated");

  const set = analyzeImpact(b.ledger, v1("RULE-A"));
  assert.deepEqual(runIds(set), ["RUN-1"]);
  assert.deepEqual(set.artifacts, []);
});

// ── Diamond ─────────────────────────────────────────────────────────────────

test("a diamond reports each node once, with one deterministic path", () => {
  //   A → B, A → C, B → D, C → D; RUN-1 consumed D (and B)
  const build = () =>
    new Build()
      .claim("A")
      .claim("B")
      .claim("C")
      .claim("D")
      .evidence(v1("A"))
      .justify([v1("A")], v1("B"), "supports", "J-AB")
      .justify([v1("A")], v1("C"), "supports", "J-AC")
      .justify([v1("B")], v1("D"), "supports", "J-BD")
      .justify([v1("C")], v1("D"), "supports", "J-CD")
      .consume("RUN-1", v1("D"))
      .consume("RUN-1", v1("B"))
      .revise("A", "A, restated");

  const set = analyzeImpact(build().ledger, v1("A"));
  assert.deepEqual(claimIds(set), ["B:v1", "C:v1", "D:v1"]);
  assert.deepEqual(set.semantic.affectedClaims[2].reasons, ["premise-unsupported"]);
  // D is explained through B: shortest path, ties by ledger order.
  assert.equal(
    render(pathFor(set, "D:v1")!),
    "-- premise-of(J-AB) --> B:v1 -- premise-of(J-BD) --> D:v1",
  );
  assert.deepEqual(set.executions, [
    {
      execution: { runId: "RUN-1" },
      reasons: ["consumed-affected-claim"],
      consumed: [v1("D"), v1("B")],
    },
  ]);
  // The run is explained through its shortest route (B, one hop), not D.
  assert.equal(
    render(pathFor(set, "RUN-1")!),
    "-- premise-of(J-AB) --> B:v1 -- consumed-by --> RUN-1",
  );
  assert.equal(set.paths.length, 4);

  // Same ledger, same answer — byte for byte.
  assert.equal(JSON.stringify(analyzeImpact(build().ledger, v1("A"))), JSON.stringify(set));
});

// ── Purity and safety ───────────────────────────────────────────────────────

test("analyzeImpact writes nothing and throws for an unknown revision", () => {
  const b = new Build()
    .claim("A")
    .claim("B")
    .justify([v1("A")], v1("B"))
    .consume("RUN-1", v1("B"));
  const before = JSON.stringify(b.ledger);
  const ledger = b.ledger;
  analyzeImpact(ledger, v1("A"));
  assert.equal(JSON.stringify(ledger), before);
  assert.equal(b.ledger, ledger);
  assert.throws(
    () => analyzeImpact(ledger, v("A", 2)),
    (e: Error) => e.name === "UnknownClaimError",
  );
});

test("a cyclic ledger from outside the API still analyzes, never hangs", () => {
  const b = new Build().claim("A").claim("B").evidence(v1("A")).consume("RUN-1", v1("B"));
  const ledger: KnowledgeLedger = {
    ...b.ledger,
    justifications: [
      { id: "J-1", conclusion: v1("B"), premises: [v1("A")], direction: "supports", createdAt: T0 },
      { id: "J-2", conclusion: v1("A"), premises: [v1("B")], direction: "supports", createdAt: T0 },
    ],
  };
  const withOpposition = addEvidence(
    ledger,
    { id: "EV-x", claim: v1("A"), direction: "opposes", source: { type: "human", who: "x" } },
    T0,
  ).ledger;
  const set = analyzeImpact(withOpposition, v1("A"));
  assert.deepEqual(set.root.conditions, ["contested"]);
  assert.deepEqual(claimIds(set), ["B:v1"]);
  assert.deepEqual(runIds(set), ["RUN-1"]);
});
