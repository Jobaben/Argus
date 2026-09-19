import type {
  ArtifactImpact,
  ClaimImpact,
  ClaimRef,
  ClaimSupport,
  ExecutionImpact,
  ImpactHop,
  ImpactPath,
  ImpactReason,
  ImpactSet,
  JustificationForce,
  JustificationImpact,
  RootCondition,
} from "@argus/contracts";
import {
  UnknownClaimError,
  evaluate,
  executionOf,
  forceOf,
  formatClaimRef,
  getClaim,
  lifecycleOf,
  newEvaluation,
  sameRef,
  type KnowledgeLedger,
} from "./kernel.js";

/**
 * Deterministic semantic impact analysis.
 *
 * The question is not "what is reachable from this revision?" — Phase 1's
 * `transitiveDependentsOf` already answers that, and it over-reports: a
 * conclusion with a second, independent justification still in force is
 * reachable but unharmed. The question is:
 *
 * > Which claims, executions and artifacts rest on this revision being the
 * > current, supported one — given everything else in the ledger as it is?
 *
 * It is answered by running Phase 1's support evaluator twice over the same
 * ledger: once as it stands (**actual**), and once with the root *held* — an
 * `Evaluation.assume` that treats the root as active and `supported` no
 * matter what the ledger says (**ifRootHeld**). Whatever differs between the
 * two is the impact of the root's condition, and nothing else is:
 *
 * - a justification is affected iff its force differs;
 * - a claim is affected iff its derived support differs;
 * - an execution is affected iff it consumed the root or an affected claim;
 * - an artifact is affected iff an affected execution produced it.
 *
 * `evaluateSupport` therefore stays the one source of truth for what
 * "supported" means; this module adds no second definition. Supersession and
 * loss of support are kept apart the whole way through: the root's
 * `conditions` say which it is, and every hop that fails on a premise says
 * *why* that premise fails (`premise-superseded` vs `premise-unsupported`
 * vs `premise-contested`).
 *
 * Pure: no clock, no I/O, no writes, and every list is in a stable order —
 * breadth-first from the root, ties by ledger order — with one explanation
 * path per node. Cycle-safe by construction (the evaluator is, and the
 * traversal keeps a visited set).
 */

const REASON_ORDER: ImpactReason[] = [
  "premise-superseded",
  "premise-unsupported",
  "premise-contested",
  "support-changed",
  "consumed-affected-claim",
  "produced-by-affected-execution",
];

const ref = (r: ClaimRef): ClaimRef => ({ id: r.id, revision: r.revision });

function sortReasons(reasons: Iterable<ImpactReason>): ImpactReason[] {
  return [...new Set(reasons)].sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
}

export function analyzeImpact(ledger: KnowledgeLedger, root: ClaimRef): ImpactSet {
  if (!getClaim(ledger, root)) {
    throw new UnknownClaimError(`unknown claim revision ${formatClaimRef(root)}`);
  }
  const rootKey = formatClaimRef(root);
  const actual = newEvaluation();
  const held = newEvaluation(root);

  // ── The root's own condition ──────────────────────────────────────────────
  const lifecycle = lifecycleOf(ledger, root);
  const support = evaluate(ledger, root, actual);
  const conditions: RootCondition[] = [];
  if (lifecycle === "superseded") conditions.push("superseded");
  if (support !== "supported") conditions.push(support);
  const rootOut: ImpactSet["root"] = { claim: ref(root), lifecycle, support, conditions };
  if (conditions.length === 0) {
    // Active and supported: holding it changes nothing, so nothing is impacted.
    return {
      root: rootOut,
      semantic: { affectedClaims: [], affectedJustifications: [] },
      executions: [],
      artifacts: [],
      paths: [],
    };
  }

  // ── Justifications whose force differs ────────────────────────────────────
  const affectedJustifications: JustificationImpact[] = [];
  const affectedJ = new Set<string>();
  const actualForce = new Map<string, JustificationForce>();
  for (const j of ledger.justifications) {
    const a = forceOf(ledger, j, actual);
    const h = forceOf(ledger, j, held);
    actualForce.set(j.id, a);
    if (a.inForce === h.inForce) continue;
    affectedJ.add(j.id);
    affectedJustifications.push({
      id: j.id,
      conclusion: ref(j.conclusion),
      inForce: { ifRootHeld: h.inForce, actual: a.inForce },
    });
  }

  // ── Claims whose derived support differs (the root itself excluded) ───────
  const changed = new Map<string, { ifRootHeld: ClaimSupport; actual: ClaimSupport }>();
  for (const c of ledger.claims) {
    if (sameRef(c, root)) continue;
    const a = evaluate(ledger, c, actual);
    const h = evaluate(ledger, c, held);
    if (a !== h) changed.set(formatClaimRef(c), { ifRootHeld: h, actual: a });
  }
  const isAffected = (r: ClaimRef) => {
    const key = formatClaimRef(r);
    return key === rootKey || changed.has(key);
  };

  // ── Order and explain: breadth-first from the root over affected edges ───
  // An edge P → C exists when an affected justification names P as a premise
  // and concludes C, and C's support changed. Every changed claim is reachable
  // this way on a ledger the API wrote (its support changed, so a justification
  // concluding it changed force, so one of that justification's premises
  // changed — the root, or a changed claim closer to the root). The visited
  // map makes the walk terminate on any ledger regardless.
  const hops = new Map<string, ImpactHop[]>([[rootKey, []]]);
  const order: ClaimRef[] = [];
  const queue: ClaimRef[] = [root];
  while (queue.length > 0) {
    const p = queue.shift()!;
    const pKey = formatClaimRef(p);
    for (const j of ledger.justifications) {
      if (!affectedJ.has(j.id) || !j.premises.some((x) => sameRef(x, p))) continue;
      const cKey = formatClaimRef(j.conclusion);
      if (!changed.has(cKey) || hops.has(cKey)) continue;
      hops.set(cKey, [
        ...hops.get(pKey)!,
        { via: "premise-of", justification: j.id, to: { kind: "claim", claim: ref(j.conclusion) } },
      ]);
      order.push(ref(j.conclusion));
      queue.push(j.conclusion);
    }
  }
  // Unreachable changed claims — only conceivable on a hand-edited, cyclic
  // ledger — are still reported (their support did change), in ledger order,
  // without an explanation path; nothing downstream borrows one either.
  for (const c of ledger.claims) {
    const key = formatClaimRef(c);
    if (changed.has(key) && !hops.has(key)) order.push(ref(c));
  }

  const affectedClaims: ClaimImpact[] = order.map((c) => {
    const key = formatClaimRef(c);
    const reasons: ImpactReason[] = [];
    for (const j of ledger.justifications) {
      if (!affectedJ.has(j.id) || !sameRef(j.conclusion, c)) continue;
      const force = actualForce.get(j.id)!;
      if (force.inForce) continue;
      for (const f of force.failing) {
        if (f.reason === "missing" || !isAffected(f.premise)) continue;
        reasons.push(`premise-${f.reason}`);
      }
    }
    const claim = getClaim(ledger, c)!;
    return {
      claim: c,
      reasons: sortReasons(reasons.length > 0 ? reasons : ["support-changed"]),
      support: changed.get(key)!,
      ...(claim.producedBy ? { producedBy: claim.producedBy } : {}),
    };
  });

  // ── Executions that consumed the root or an affected claim ───────────────
  // Consumers only. An execution that *produced* an affected claim is named
  // on that claim's `producedBy` and is not thereby impacted: it created the
  // knowledge, it did not build on it.
  const executions: ExecutionImpact[] = [];
  const byRun = new Map<string, ExecutionImpact>();
  for (const c of ledger.consumptions) {
    if (!isAffected(c.claim)) continue;
    let e = byRun.get(c.execution.runId);
    if (!e) {
      e = {
        execution: executionOf(ledger, c.execution.runId) ?? { runId: c.execution.runId },
        reasons: ["consumed-affected-claim"],
        consumed: [],
      };
      byRun.set(c.execution.runId, e);
      executions.push(e);
    }
    if (!e.consumed.some((x) => sameRef(x, c.claim))) e.consumed.push(ref(c.claim));
  }
  // An execution is explained through the consumed claim with the shortest
  // path; ties go to the one recorded first.
  const executionHops = new Map<string, ImpactHop[]>();
  for (const e of executions) {
    let best: ImpactHop[] | undefined;
    for (const c of e.consumed) {
      const h = hops.get(formatClaimRef(c));
      if (h && (!best || h.length < best.length)) best = h;
    }
    if (!best) continue;
    executionHops.set(e.execution.runId, [
      ...best,
      { via: "consumed-by", to: { kind: "execution", execution: e.execution } },
    ]);
  }

  // ── Artifacts those executions produced ──────────────────────────────────
  const artifacts: ArtifactImpact[] = [];
  const artifactHops: ImpactHop[][] = [];
  for (const a of ledger.artifacts) {
    const e = byRun.get(a.execution.runId);
    if (!e) continue;
    artifacts.push({
      execution: e.execution,
      artifact: a.artifact,
      reasons: ["produced-by-affected-execution"],
    });
    const h = executionHops.get(e.execution.runId);
    if (h) {
      artifactHops.push([
        ...h,
        { via: "produced", to: { kind: "artifact", execution: e.execution, artifact: a.artifact } },
      ]);
    }
  }

  // ── Paths: one per explained node, claims then executions then artifacts ─
  const paths: ImpactPath[] = [];
  for (const c of order) {
    const h = hops.get(formatClaimRef(c));
    if (h) paths.push({ target: { kind: "claim", claim: c }, hops: h });
  }
  for (const e of executions) {
    const h = executionHops.get(e.execution.runId);
    if (h) paths.push({ target: { kind: "execution", execution: e.execution }, hops: h });
  }
  for (const h of artifactHops) {
    paths.push({ target: h[h.length - 1].to, hops: h });
  }

  return {
    root: rootOut,
    semantic: { affectedClaims, affectedJustifications },
    executions,
    artifacts,
    paths,
  };
}
