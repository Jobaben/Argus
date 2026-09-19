import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaimKind, ClaimRef } from "@argus/contracts";
import {
  addClaim,
  addEvidence,
  addJustification,
  dependentsOf,
  dependentsReport,
  emptyLedger,
  evaluateSupport,
  formatClaimRef,
  lifecycleOf,
  parseClaimKey,
  premisesOf,
  reviseClaim,
  supportReport,
  transitiveDependentsOf,
  viewOf,
  type KnowledgeLedger,
} from "./kernel.js";

/**
 * The semantic kernel, exercised on hand-built ledgers: no filesystem, no
 * clock, no ids minted. Every scenario the Knowledge Ledger promises is here,
 * so a change in `evaluateSupport` that alters what "supported" means fails a
 * named test rather than an operator's expectation.
 */

const T0 = "2026-09-19T10:00:00.000Z";
const T1 = "2026-09-19T10:01:00.000Z";

const v1 = (id: string): ClaimRef => ({ id, revision: 1 });
const v = (id: string, revision: number): ClaimRef => ({ id, revision });

/** A tiny builder so a scenario reads as its graph, not as bookkeeping. */
class Build {
  ledger: KnowledgeLedger = emptyLedger();
  private n = 0;

  claim(id: string, kind: ClaimKind = "fact", statement = `${id} holds`): this {
    this.ledger = addClaim(this.ledger, { id, kind, statement }, T0).ledger;
    return this;
  }
  /** Ground a claim with one piece of supporting (or opposing) human evidence. */
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
}

const refs = (list: ClaimRef[]) => list.map(formatClaimRef);

// ── Identity ────────────────────────────────────────────────────────────────

test("parseClaimKey distinguishes a logical id from a revision ref", () => {
  assert.deepEqual(parseClaimKey("RULE-17"), { id: "RULE-17" });
  assert.deepEqual(parseClaimKey("RULE-17:v2"), { id: "RULE-17", revision: 2 });
  assert.equal(parseClaimKey("RULE-17:v0"), null);
  assert.equal(parseClaimKey("RULE-17:2"), null);
  assert.equal(parseClaimKey("RULE 17"), null);
  assert.equal(parseClaimKey("../etc"), null);
  assert.equal(parseClaimKey(""), null);
  assert.equal(formatClaimRef({ id: "RULE-17", revision: 2 }), "RULE-17:v2");
});

test("a claim id is unique; a repeated add is refused, not silently revised", () => {
  const b = new Build().claim("FACT-A");
  assert.throws(
    () => addClaim(b.ledger, { id: "FACT-A", kind: "fact", statement: "again" }, T0),
    /already exists/,
  );
  assert.throws(
    () => addClaim(b.ledger, { id: "bad id!", kind: "fact", statement: "x" }, T0),
    /invalid/,
  );
  assert.throws(
    () => addClaim(b.ledger, { id: "X", kind: "opinion" as ClaimKind, statement: "x" }, T0),
    /kind/,
  );
});

test("transitions never mutate their input ledger", () => {
  const start = emptyLedger();
  const { ledger: next } = addClaim(start, { id: "A", kind: "fact", statement: "a" }, T0);
  assert.equal(start.claims.length, 0);
  assert.equal(next.claims.length, 1);
  const { ledger: after } = reviseClaim(next, { id: "A", statement: "a2" }, T1);
  assert.equal(next.claims.length, 1);
  assert.equal(after.claims.length, 2);
});

// ── Basic support ───────────────────────────────────────────────────────────

test("FACT-A + RULE-B → CONCLUSION-C: C is supported when both premises are", () => {
  const b = new Build()
    .claim("FACT-A")
    .claim("RULE-B", "business-rule")
    .claim("CONCLUSION-C", "conclusion")
    .evidence(v1("FACT-A"))
    .evidence(v1("RULE-B"))
    .justify([v1("FACT-A"), v1("RULE-B")], v1("CONCLUSION-C"));

  assert.equal(evaluateSupport(b.ledger, v1("FACT-A")), "supported");
  assert.equal(evaluateSupport(b.ledger, v1("RULE-B")), "supported");
  assert.equal(evaluateSupport(b.ledger, v1("CONCLUSION-C")), "supported");

  const report = supportReport(b.ledger, v1("CONCLUSION-C"));
  assert.equal(report.support, "supported");
  assert.equal(report.justifications.length, 1);
  assert.deepEqual(report.justifications[0].force, { inForce: true });
  assert.deepEqual(refs(report.justifications[0].justification.premises), [
    "FACT-A:v1",
    "RULE-B:v1",
  ]);
});

test("a claim with neither evidence nor a justification is unsupported", () => {
  const b = new Build().claim("LONELY");
  assert.equal(evaluateSupport(b.ledger, v1("LONELY")), "unsupported");
});

test("a justification is not in force while any premise is itself unsupported", () => {
  // A is grounded, B is not — A ∧ B → C does not carry C.
  const b = new Build()
    .claim("A")
    .claim("B")
    .claim("C", "conclusion")
    .evidence(v1("A"))
    .justify([v1("A"), v1("B")], v1("C"));
  assert.equal(evaluateSupport(b.ledger, v1("C")), "unsupported");
  const [status] = supportReport(b.ledger, v1("C")).justifications;
  assert.deepEqual(status.force, {
    inForce: false,
    failing: [{ premise: v1("B"), reason: "unsupported" }],
  });
});

test("support flows through chains: grounded root → derived → derived", () => {
  const b = new Build()
    .claim("A")
    .claim("B", "conclusion")
    .claim("C", "decision")
    .evidence(v1("A"))
    .justify([v1("A")], v1("B"))
    .justify([v1("B")], v1("C"));
  assert.equal(evaluateSupport(b.ledger, v1("C")), "supported");
});

// ── Multiple justifications ─────────────────────────────────────────────────

test("A+B → C and D+E → C: C survives losing A/B while D/E hold", () => {
  const b = new Build()
    .claim("A")
    .claim("B")
    .claim("D")
    .claim("E")
    .claim("C", "conclusion")
    .evidence(v1("A"))
    .evidence(v1("B"))
    .evidence(v1("D"))
    .evidence(v1("E"))
    .justify([v1("A"), v1("B")], v1("C"), "supports", "J-AB")
    .justify([v1("D"), v1("E")], v1("C"), "supports", "J-DE");
  assert.equal(evaluateSupport(b.ledger, v1("C")), "supported");

  // A is revised: A:v1 is superseded, so J-AB loses force. J-DE still holds.
  b.revise("A", "A, restated");
  assert.equal(evaluateSupport(b.ledger, v1("C")), "supported");
  const report = supportReport(b.ledger, v1("C"));
  const byId = new Map(report.justifications.map((s) => [s.justification.id, s.force]));
  assert.deepEqual(byId.get("J-AB"), {
    inForce: false,
    failing: [{ premise: v1("A"), reason: "superseded" }],
  });
  assert.deepEqual(byId.get("J-DE"), { inForce: true });

  // Now D goes too, and C has nothing left in force.
  b.revise("D", "D, restated");
  assert.equal(evaluateSupport(b.ledger, v1("C")), "unsupported");
});

// ── Supersession ────────────────────────────────────────────────────────────

test("RULE:v1 → C, then RULE revised: v1 retained, v2 active, justification untouched", () => {
  const b = new Build()
    .claim("RULE-17", "business-rule", "Kobra comment maximum is 180")
    .claim("CONCLUSION-19", "conclusion", "Comment field validates at 180")
    .evidence(v1("RULE-17"))
    .justify([v1("RULE-17")], v1("CONCLUSION-19"), "supports", "J-1");
  assert.equal(evaluateSupport(b.ledger, v1("CONCLUSION-19")), "supported");

  b.revise("RULE-17", "Kobra comment maximum is 500");

  // v1 is retained, byte for byte, and marked superseded by v2.
  const old = viewOf(
    b.ledger,
    b.ledger.claims.find((c) => c.id === "RULE-17" && c.revision === 1)!,
  );
  assert.equal(old.statement, "Kobra comment maximum is 180");
  assert.equal(old.lifecycle, "superseded");
  assert.deepEqual(old.supersededBy, v("RULE-17", 2));
  // …and still supported on its own evidence: lifecycle and support are
  // separate axes, so a historical premise can be inspected as it stood.
  assert.equal(old.support, "supported");

  // v2 is the active revision, same kind, no evidence yet.
  const active = viewOf(
    b.ledger,
    b.ledger.claims.find((c) => c.id === "RULE-17" && c.revision === 2)!,
  );
  assert.equal(active.lifecycle, "active");
  assert.equal(active.kind, "business-rule");
  assert.equal(active.statement, "Kobra comment maximum is 500");
  assert.equal(active.support, "unsupported");
  assert.equal(lifecycleOf(b.ledger, v("RULE-17", 2)), "active");

  // The justification still names v1 — nothing retargeted it — and it is out
  // of force precisely because v1 is superseded.
  const [j] = premisesOf(b.ledger, v1("CONCLUSION-19"));
  assert.equal(j.id, "J-1");
  assert.deepEqual(refs(j.premises), ["RULE-17:v1"]);
  assert.equal(premisesOf(b.ledger, v("RULE-17", 2)).length, 0);
  assert.deepEqual(dependentsOf(b.ledger, v("RULE-17", 2)), []);
  assert.deepEqual(refs(dependentsOf(b.ledger, v1("RULE-17"))), ["CONCLUSION-19:v1"]);

  const report = supportReport(b.ledger, v1("CONCLUSION-19"));
  assert.equal(report.support, "unsupported");
  assert.deepEqual(report.justifications[0].force, {
    inForce: false,
    failing: [{ premise: v1("RULE-17"), reason: "superseded" }],
  });
});

test("revising keeps kind, increments revision contiguously, and refuses an unknown id", () => {
  const b = new Build().claim("R", "business-rule").revise("R", "two").revise("R", "three");
  const revisions = b.ledger.claims.filter((c) => c.id === "R").map((c) => c.revision);
  assert.deepEqual(revisions, [1, 2, 3]);
  assert.ok(b.ledger.claims.every((c) => c.kind === "business-rule"));
  assert.throws(() => reviseClaim(b.ledger, { id: "NOPE", statement: "x" }, T1), /unknown claim/);
});

test("evidence can still be attached to a superseded revision", () => {
  const b = new Build().claim("R").revise("R", "two");
  const { ledger } = addEvidence(
    b.ledger,
    { id: "EV-late", claim: v1("R"), direction: "supports", source: { type: "human", who: "me" } },
    T1,
  );
  assert.equal(evaluateSupport(ledger, v1("R")), "supported");
  assert.equal(evaluateSupport(ledger, v("R", 2)), "unsupported");
});

// ── Transitive dependency ───────────────────────────────────────────────────

test("A → B → C → D: transitive dependents of A are B, C, D in order", () => {
  const b = new Build()
    .claim("A")
    .claim("B")
    .claim("C")
    .claim("D")
    .justify([v1("A")], v1("B"))
    .justify([v1("B")], v1("C"))
    .justify([v1("C")], v1("D"));
  assert.deepEqual(refs(dependentsOf(b.ledger, v1("A"))), ["B:v1"]);
  assert.deepEqual(refs(transitiveDependentsOf(b.ledger, v1("A"))), ["B:v1", "C:v1", "D:v1"]);
  assert.deepEqual(refs(transitiveDependentsOf(b.ledger, v1("C"))), ["D:v1"]);
  assert.deepEqual(transitiveDependentsOf(b.ledger, v1("D")), []);

  const report = dependentsReport(b.ledger, v1("A"));
  assert.deepEqual(report.claim, v1("A"));
  assert.deepEqual(refs(report.direct), ["B:v1"]);
  assert.deepEqual(refs(report.transitive), ["B:v1", "C:v1", "D:v1"]);
});

test("a diamond is reported once per revision, breadth-first, deterministically", () => {
  //   A → B, A → C, B → D, C → D, D → E
  const b = new Build()
    .claim("A")
    .claim("B")
    .claim("C")
    .claim("D")
    .claim("E")
    .justify([v1("A")], v1("B"))
    .justify([v1("A")], v1("C"))
    .justify([v1("B")], v1("D"))
    .justify([v1("C")], v1("D"))
    .justify([v1("D")], v1("E"));
  const once = refs(transitiveDependentsOf(b.ledger, v1("A")));
  assert.deepEqual(once, ["B:v1", "C:v1", "D:v1", "E:v1"]);
  assert.deepEqual(refs(transitiveDependentsOf(b.ledger, v1("A"))), once);
});

test("dependents include conclusions of opposing justifications", () => {
  const b = new Build()
    .claim("X")
    .claim("Y")
    .justify([v1("X")], v1("Y"), "opposes");
  assert.deepEqual(refs(dependentsOf(b.ledger, v1("X"))), ["Y:v1"]);
});

// ── Opposition / contested ──────────────────────────────────────────────────

test("supporting and opposing signals both in force → contested", () => {
  const b = new Build()
    .claim("A")
    .claim("N")
    .claim("C", "conclusion")
    .evidence(v1("A"))
    .evidence(v1("N"))
    .justify([v1("A")], v1("C"), "supports")
    .justify([v1("N")], v1("C"), "opposes");
  assert.equal(evaluateSupport(b.ledger, v1("C")), "contested");

  // Take the opposing premise out of force (revise N) → C is supported again.
  b.revise("N", "N, restated");
  assert.equal(evaluateSupport(b.ledger, v1("C")), "supported");
});

test("opposing evidence alone makes a claim unsupported, not contested", () => {
  const b = new Build().claim("C").evidence(v1("C"), "opposes");
  assert.equal(evaluateSupport(b.ledger, v1("C")), "unsupported");
  const report = supportReport(b.ledger, v1("C"));
  assert.equal(report.evidence.length, 1);
  assert.equal(report.evidence[0].direction, "opposes");
});

test("supporting evidence plus opposing evidence on one revision → contested", () => {
  const b = new Build().claim("C").evidence(v1("C"), "supports").evidence(v1("C"), "opposes");
  assert.equal(evaluateSupport(b.ledger, v1("C")), "contested");
});

test("a contested premise does not transmit support", () => {
  const b = new Build()
    .claim("P")
    .claim("C", "conclusion")
    .evidence(v1("P"), "supports")
    .evidence(v1("P"), "opposes")
    .justify([v1("P")], v1("C"));
  assert.equal(evaluateSupport(b.ledger, v1("C")), "unsupported");
  assert.deepEqual(supportReport(b.ledger, v1("C")).justifications[0].force, {
    inForce: false,
    failing: [{ premise: v1("P"), reason: "contested" }],
  });
});

test("an opposing justification whose premise is unsupported has no force", () => {
  const b = new Build()
    .claim("A")
    .claim("N")
    .claim("C")
    .evidence(v1("A"))
    .justify([v1("A")], v1("C"), "supports")
    .justify([v1("N")], v1("C"), "opposes"); // N has no evidence
  assert.equal(evaluateSupport(b.ledger, v1("C")), "supported");
});

// ── Invalid references ──────────────────────────────────────────────────────

test("a justification naming a nonexistent claim revision fails validation", () => {
  const b = new Build().claim("A").claim("C");
  const attempt = (premises: ClaimRef[], conclusion: ClaimRef) =>
    addJustification(b.ledger, { id: "J-x", conclusion, premises, direction: "supports" }, T0);
  assert.throws(() => attempt([v1("GHOST")], v1("C")), /unknown premise GHOST:v1/);
  assert.throws(() => attempt([v("A", 2)], v1("C")), /unknown premise A:v2/);
  assert.throws(() => attempt([v1("A")], v1("GHOST")), /unknown conclusion GHOST:v1/);
  assert.throws(() => attempt([], v1("C")), /at least one premise/);
  assert.throws(() => attempt([v1("A"), v1("A")], v1("C")), /listed twice/);
  // Nothing was written by a refused transition.
  assert.equal(b.ledger.justifications.length, 0);
});

test("evidence naming a nonexistent claim revision fails validation", () => {
  const b = new Build().claim("A");
  assert.throws(
    () =>
      addEvidence(
        b.ledger,
        {
          id: "EV-x",
          claim: v("A", 3),
          direction: "supports",
          source: { type: "human", who: "me" },
        },
        T0,
      ),
    /unknown claim revision A:v3/,
  );
});

test("evaluating or traversing an unknown revision throws UnknownClaimError", () => {
  const b = new Build().claim("A");
  assert.throws(
    () => evaluateSupport(b.ledger, v("A", 2)),
    (e: Error) => e.name === "UnknownClaimError",
  );
  assert.throws(
    () => supportReport(b.ledger, v1("Z")),
    (e: Error) => e.name === "UnknownClaimError",
  );
  assert.throws(
    () => dependentsReport(b.ledger, v1("Z")),
    (e: Error) => e.name === "UnknownClaimError",
  );
});

// ── Cycles ──────────────────────────────────────────────────────────────────

test("justification cycles are rejected: self, direct and transitive", () => {
  const b = new Build()
    .claim("A")
    .claim("B")
    .claim("C")
    .justify([v1("A")], v1("B"))
    .justify([v1("B")], v1("C"));
  const attempt = (premises: ClaimRef[], conclusion: ClaimRef) =>
    addJustification(b.ledger, { id: "J-x", conclusion, premises, direction: "supports" }, T0);
  assert.throws(() => attempt([v1("A")], v1("A")), /cannot justify itself/);
  assert.throws(
    () => attempt([v1("B")], v1("A")),
    /would form a cycle: B:v1 already depends on A:v1/,
  );
  assert.throws(() => attempt([v1("C")], v1("A")), /would form a cycle/);
  // An opposing edge closes a cycle just the same.
  assert.throws(
    () =>
      addJustification(
        b.ledger,
        { id: "J-x", conclusion: v1("A"), premises: [v1("C")], direction: "opposes" },
        T0,
      ),
    /would form a cycle/,
  );
  // A second edge in the same direction is fine (it is a DAG, not a tree).
  assert.doesNotThrow(() => attempt([v1("A")], v1("C")));
});

test("revisions are distinct nodes: R:v2 may be justified by R:v1", () => {
  const b = new Build().claim("R").revise("R", "two");
  assert.doesNotThrow(() =>
    addJustification(
      b.ledger,
      { id: "J-x", conclusion: v("R", 2), premises: [v1("R")], direction: "supports" },
      T0,
    ),
  );
});

test("a cyclic ledger from outside the API still evaluates (as unsupported), never hangs", () => {
  // Hand-build what addJustification would refuse.
  const b = new Build().claim("A").claim("B").evidence(v1("A"));
  const ledger: KnowledgeLedger = {
    ...b.ledger,
    justifications: [
      { id: "J-1", conclusion: v1("B"), premises: [v1("A")], direction: "supports", createdAt: T0 },
      { id: "J-2", conclusion: v1("A"), premises: [v1("B")], direction: "supports", createdAt: T0 },
    ],
  };
  // A has its own evidence and B derives from A; B → A is a cycle, so on the
  // way round B cannot lend A anything — A stands on its evidence alone.
  assert.equal(evaluateSupport(ledger, v1("A")), "supported");
  assert.equal(evaluateSupport(ledger, v1("B")), "supported");
  assert.deepEqual(refs(transitiveDependentsOf(ledger, v1("A"))), ["B:v1"]);
});

// ── Views ───────────────────────────────────────────────────────────────────

test("viewOf derives lifecycle, supersededBy and support without storing them", () => {
  const b = new Build().claim("A").evidence(v1("A")).revise("A", "two");
  const stored = b.ledger.claims[0] as unknown as Record<string, unknown>;
  assert.equal("lifecycle" in stored, false);
  assert.equal("support" in stored, false);
  assert.equal("truth" in stored, false);
  const view = viewOf(b.ledger, b.ledger.claims[0]);
  assert.equal(view.lifecycle, "superseded");
  assert.deepEqual(view.supersededBy, v("A", 2));
  assert.equal(view.support, "supported");
  const active = viewOf(b.ledger, b.ledger.claims[1]);
  assert.equal(active.lifecycle, "active");
  assert.equal(active.supersededBy, undefined);
});
