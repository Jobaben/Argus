/**
 * Deterministic implementation scope (Phase 8) — the pure half.
 *
 * Before an implementation agent is launched against an accepted
 * {@link AcceptedChangeProposal}, Argus answers one question from its own
 * records and from nothing else:
 *
 *   > Where, in this repository, does the ledger say this change lives?
 *
 * Everything it uses is exact provenance that already exists:
 *
 *   revised RULE-42:v1 → v2
 *         ↓ analyzeImpact(RULE-42:v1)          Phase 2, unchanged
 *     consumer executions  →  the artifacts they produced
 *         ↓ evidenceOf(RULE-42:v1 / :v2)       Phase 1/5 source-code evidence
 *     where the rule lives in the code
 *         ↓ verificationsOfClaim(RULE-42:v1)   Phase 6 conformance evidence
 *     where somebody last looked when they decided whether it conformed
 *         ↓ preserved revisions' own evidence   the regression surface
 *         ↓ ChangeRequest.scope.paths           the requester's own words
 *
 * There is **no second impact algorithm**: `analyzeImpact` is called, not
 * reimplemented. There is no similarity, no embedding, no model and no
 * heuristic — every entry carries a closed {@link ScopeReasonCode} and, where
 * it has one, the exact claim, execution or evidence record it came from.
 *
 * And it never claims to be exhaustive. A change whose rules nothing has ever
 * implemented produces **no** targets from provenance, and the honest answer
 * to that is `scope-incomplete` — not an empty list that reads as "nothing to
 * do". That distinction is the whole reason `completeness` exists.
 */

import type {
  AcceptedChangeProposal,
  ArtifactRef,
  ChangeRequest,
  ClaimRef,
  ImplementationScope,
  ImplementationScopeCompleteness,
  ImplementationTarget,
  RunExecutionRef,
  KnowledgeScope,
  ScopeReason,
  SourceCodeEvidence,
} from "@argus/contracts";
import {
  evidenceOf,
  formatClaimRef,
  getClaim,
  sameRef,
  scopeOfAcceptedChange,
  verificationsOfClaim,
  type KnowledgeLedger,
} from "./kernel.js";
import { analyzeImpact } from "./impact.js";
import { plainScope } from "./scope.js";

/** How many targets one scope may carry. A change is a bounded piece of work;
 *  a scope that named a thousand files would not be guidance. */
export const SCOPE_TARGET_MAX = 200;

export interface ScopeOptions {
  /** Include the source evidence of preserved revisions as regression
   *  surface. Default true. */
  includePreserved?: boolean;
  /** The moment the document is stamped with. */
  now: string;
}

interface Accum {
  targets: Map<string, ImplementationTarget>;
  executions: RunExecutionRef[];
}

const key = (location: ArtifactRef["location"], path: string) => `${location}:${path}`;

function add(acc: Accum, location: ArtifactRef["location"], path: string, reason: ScopeReason) {
  const k = key(location, path);
  const existing = acc.targets.get(k);
  if (existing) {
    // A path may legitimately arrive for several reasons; each is kept, and
    // duplicates of the same (code, claim, evidence) triple are not.
    const duplicate = existing.reasons.some(
      (r) =>
        r.code === reason.code &&
        r.evidenceId === reason.evidenceId &&
        r.execution?.runId === reason.execution?.runId &&
        ((!r.claim && !reason.claim) ||
          (r.claim && reason.claim ? sameRef(r.claim, reason.claim) : false)),
    );
    if (!duplicate) existing.reasons.push(reason);
    return;
  }
  if (acc.targets.size >= SCOPE_TARGET_MAX) return;
  acc.targets.set(k, { path, location, reasons: [reason], preserveOnly: false });
}

function noteExecution(acc: Accum, execution: RunExecutionRef): void {
  if (!acc.executions.some((e) => e.runId === execution.runId)) acc.executions.push(execution);
}

/** Every `source-code` evidence record grounding one exact revision. */
function sourceEvidence(
  ledger: KnowledgeLedger,
  ref: ClaimRef,
): Array<{ id: string; source: SourceCodeEvidence }> {
  return evidenceOf(ledger, ref).flatMap((e) =>
    e.source.type === "source-code" ? [{ id: e.id, source: e.source }] : [],
  );
}

/**
 * Derive the deterministic implementation scope of one accepted change.
 *
 * Pure: a ledger snapshot in, a document out. No clock beyond the `now` it is
 * handed, no filesystem, no ordering that depends on anything but the ledger.
 */
export function deriveImplementationScope(
  ledger: KnowledgeLedger,
  accepted: AcceptedChangeProposal,
  opts: ScopeOptions,
): ImplementationScope {
  const acc: Accum = { targets: new Map(), executions: [] };
  const includePreserved = opts.includePreserved ?? true;
  // Every target below is a **repository-relative path**, which means nothing
  // without the repository it came from. The whole derivation is therefore
  // bounded by the knowledge scope that owns the change: `analyzeImpact` walks
  // only that scope, and `evidenceOf` / `verificationsOfClaim` are keyed by
  // scope-qualified refs, so no other project's file path can reach an
  // implementation agent's ARGUS_IMPLEMENTATION_SCOPE_FILE. The scope is read
  // off the change's own semantics rather than passed in, so it is whatever
  // the accepted proposal actually revised.
  const scope: KnowledgeScope | undefined = scopeOfAcceptedChange(ledger, accepted);

  // ── 1. Impact: what the superseded revisions' consumers produced ─────────
  // The root is the *predecessor*, never the new revision: a v2 nobody has
  // consumed yet has no dependents, and the work to be redone is the work that
  // rested on v1. `analyzeImpact` is Phase 2's, called rather than re-derived.
  for (const { from } of accepted.revised) {
    if (!getClaim(ledger, from)) continue;
    let impact;
    try {
      impact = analyzeImpact(ledger, from);
    } catch {
      continue; // an unknown revision: nothing to say, and never a throw here
    }
    for (const e of impact.executions) noteExecution(acc, e.execution);
    for (const a of impact.artifacts) {
      add(acc, a.artifact.location, a.artifact.path, {
        code: "impact-artifact",
        claim: from,
        execution: a.execution,
        detail: `produced by run ${a.execution.runId}, which consumed ${formatClaimRef(from)}`,
      });
    }
  }

  // ── 2. Where the changed rules live in the code ──────────────────────────
  // Both sides of a revision: the new statement's evidence when the change
  // agent attached any, and the old one's, which is where the behaviour being
  // changed actually is today.
  const changed: ClaimRef[] = [...accepted.semanticChanges, ...accepted.revised.map((r) => r.from)];
  for (const ref of changed) {
    for (const { id, source } of sourceEvidence(ledger, ref)) {
      add(acc, "repository", source.path, {
        code: "source-code-evidence",
        claim: ref,
        evidenceId: id,
        detail: `source-code evidence for ${formatClaimRef(ref)}`,
      });
    }
    // Where the last accepted verification looked. Evidence Argus itself
    // validated, from a record no agent could forge the status of.
    for (const v of verificationsOfClaim(ledger, ref)) {
      for (const e of v.evidence) {
        if (e.type !== "source-code") continue;
        add(acc, "repository", e.path, {
          code: "verification-evidence",
          claim: ref,
          execution: v.execution,
          detail: `cited by verification ${v.id} (${v.outcome}) of ${formatClaimRef(ref)}`,
        });
      }
    }
  }

  // ── 3. The regression surface: what must keep behaving as it does ────────
  if (includePreserved) {
    for (const ref of accepted.preserved) {
      for (const { id, source } of sourceEvidence(ledger, ref)) {
        add(acc, "repository", source.path, {
          code: "preserved-evidence",
          claim: ref,
          evidenceId: id,
          detail: `${formatClaimRef(ref)} is preserved: its behaviour must not change`,
        });
      }
    }
  }

  // ── 4. The requester's own words ─────────────────────────────────────────
  // Carried through verbatim and labelled as a hint. Deliberately *not*
  // counted as provenance below: a request that names a directory must not
  // make a change with no implementation history read as fully scoped.
  const requestedPaths = requestScopePaths(accepted.request);
  for (const path of requestedPaths) {
    add(acc, "repository", path, {
      code: "request-scope",
      detail: `named by the change request's own scope`,
    });
  }

  const targets = [...acc.targets.values()]
    .map((t) => ({ ...t, preserveOnly: t.reasons.every((r) => r.code === "preserved-evidence") }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.location.localeCompare(b.location));

  // ── Completeness ─────────────────────────────────────────────────────────
  // Asked only of the **business rules** this change introduces or revises:
  // those are what an implementation implements. A decision or a constraint
  // claim constrains *how*, and having no file of its own is normal rather
  // than a gap.
  const withoutTargets: ClaimRef[] = [];
  for (const ref of accepted.semanticChanges) {
    const claim = getClaim(ledger, ref);
    if (!claim || claim.kind !== "business-rule") continue;
    const predecessor = accepted.revised.find((r) => sameRef(r.to, ref))?.from;
    const covered = targets.some((t) =>
      t.reasons.some(
        (r) =>
          r.code !== "request-scope" &&
          r.code !== "preserved-evidence" &&
          r.claim !== undefined &&
          (sameRef(r.claim, ref) || (predecessor ? sameRef(r.claim, predecessor) : false)),
      ),
    );
    if (!covered) withoutTargets.push({ id: ref.id, revision: ref.revision });
  }
  const completeness: ImplementationScopeCompleteness =
    withoutTargets.length === 0 ? "known-targets" : "scope-incomplete";

  return {
    schemaVersion: 1,
    generatedAt: opts.now,
    proposalId: accepted.id,
    ...(scope ? { scope: plainScope(scope) } : {}),
    semanticChanges: accepted.semanticChanges.map((r) => ({ id: r.id, revision: r.revision })),
    preserved: accepted.preserved.map((r) => ({ id: r.id, revision: r.revision })),
    targets,
    impactedExecutions: acc.executions,
    completeness,
    withoutTargets,
    requestedPaths,
  };
}

/** The request's own scope paths, trimmed and deduplicated. Unchecked, exactly
 *  as Phase 7 leaves them: a change request reads no code, so nothing is
 *  contained by them. */
export function requestScopePaths(request: ChangeRequest | undefined): string[] {
  const out: string[] = [];
  for (const raw of request?.scope?.paths ?? []) {
    const path = typeof raw === "string" ? raw.trim() : "";
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** The document text handed to the run as `ARGUS_IMPLEMENTATION_SCOPE_FILE`. */
export function implementationScopeText(scope: ImplementationScope): string {
  return `${JSON.stringify(scope, null, 2)}\n`;
}

/**
 * The prompt block an implementation step gets.
 *
 * Says what the scope is (guidance and provenance), what it is *not* (a
 * filesystem boundary — the capability profile is that, if anything is), and —
 * when Argus cannot name where the change goes — says so outright rather than
 * letting an empty list read as "nothing to do".
 */
export function implementationScopeInstruction(scope: ImplementationScope | null): string {
  if (!scope) return "";
  const work = scope.targets.filter((t) => !t.preserveOnly);
  const preserve = scope.targets.filter((t) => t.preserveOnly);
  const lines = [
    "",
    "",
    "Implementation scope. Argus has written the deterministic scope of this change to the path in",
    "the ARGUS_IMPLEMENTATION_SCOPE_FILE environment variable. Every entry carries a machine-readable",
    "reason — an artifact a run that consumed the old rule produced, source-code evidence grounding a",
    "rule this change revises, a location an accepted verification cited, or the request's own scope.",
    "It is guidance and provenance, not a boundary: read adjacent code freely, and touch what the",
    "accepted change actually requires.",
  ];
  if (work.length > 0) {
    lines.push(
      `Primary affected paths: ${work
        .slice(0, 20)
        .map((t) => t.path)
        .join(", ")}${work.length > 20 ? ` (+${work.length - 20} more in the file)` : ""}.`,
    );
  }
  if (preserve.length > 0) {
    lines.push(
      `Regression surface — behaviour here must NOT change: ${preserve
        .slice(0, 20)
        .map((t) => t.path)
        .join(", ")}.`,
    );
  }
  if (scope.completeness === "scope-incomplete") {
    lines.push(
      "Scope is INCOMPLETE: Argus has no implementation provenance for " +
        `${scope.withoutTargets.map(formatClaimRef).join(", ")}. That does not mean no work is ` +
        "required — it means nothing in the ledger says where it goes. Find the right place, and " +
        "declare the files you changed as artifacts so the next change knows.",
    );
  }
  return lines.join("\n");
}

/** One line for a journal entry or a reason. */
export function describeScope(scope: ImplementationScope): string {
  return `${scope.targets.length} target${scope.targets.length === 1 ? "" : "s"}, ${
    scope.impactedExecutions.length
  } impacted execution${scope.impactedExecutions.length === 1 ? "" : "s"}, ${scope.completeness}`;
}
