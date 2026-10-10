import type {
  AtlasClaim,
  AtlasEvidence,
  Claim,
  ClaimRef,
  KnowledgeAtlas,
  KnowledgeScope,
} from "@argus/contracts";
import { type KnowledgeLedger, formatClaimRef, refOf, ruleConformance, viewOf } from "./kernel.js";
import { claimsInScopes, plainScope, scopeKeyOf } from "./scope.js";

/**
 * The read model behind the Knowledge view: every claim revision in one scope
 * (or the whole ledger) with its evidence, conformance and consumption facts
 * already joined, so a browser can group and flag without one request per
 * claim. Derived per read from the same kernel functions the per-claim routes
 * use; it adds no semantics of its own.
 */
export function buildAtlas(ledger: KnowledgeLedger, scope?: KnowledgeScope): KnowledgeAtlas {
  const source = scope ? claimsInScopes(ledger, [scope]) : ledger.claims;
  const evidence = groupByRef(ledger.evidence, (e) => e.claim);
  const consumers = countByRef(ledger.consumptions.map((c) => c.claim));

  const claims = source.map((claim): AtlasClaim => {
    const view = viewOf(ledger, claim);
    const key = formatClaimRef(refOf(claim));
    const consumedBy = consumers.get(key) ?? 0;
    const current = view.lifecycle === "active" && view.support === "supported";
    return {
      ...view,
      evidence: (evidence.get(key) ?? []).map((e): AtlasEvidence => ({
        id: e.id,
        direction: e.direction,
        source: e.source,
      })),
      conformance:
        claim.kind === "business-rule" ? ruleConformance(ledger, refOf(claim)).status : null,
      consumers: consumedBy,
      stale: consumedBy > 0 && !current,
    };
  });

  const inView = new Set(claims.map((c) => formatClaimRef(refOf(c))));
  return {
    scope: scope ? plainScope(scope) : null,
    scopes: scopesOf(ledger.claims),
    claims,
    justifications: ledger.justifications.filter((j) => inView.has(formatClaimRef(j.conclusion))),
  };
}

function groupByRef<T>(items: T[], refOfItem: (item: T) => ClaimRef): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = formatClaimRef(refOfItem(item));
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}

function countByRef(refs: ClaimRef[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const ref of refs) {
    const key = formatClaimRef(ref);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** Distinct claim ids per scope, largest first; unscoped sorts last on a tie. */
function scopesOf(claims: Claim[]): KnowledgeAtlas["scopes"] {
  const byKey = new Map<string, { scope: KnowledgeScope | null; ids: Set<string> }>();
  for (const claim of claims) {
    const key = scopeKeyOf(claim.scope);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { scope: claim.scope ? plainScope(claim.scope) : null, ids: new Set() };
      byKey.set(key, entry);
    }
    entry.ids.add(claim.id);
  }
  return [...byKey.values()]
    .map((e) => ({ scope: e.scope, claims: e.ids.size }))
    .sort((a, b) => b.claims - a.claims || Number(a.scope === null) - Number(b.scope === null));
}
