/**
 * Business-rule discovery orchestration (Phase 5).
 *
 * Discovery is not a new subsystem. It is one *workflow* over machinery that
 * already exists, and this module is the small deterministic layer that makes
 * that workflow reviewable:
 *
 *   bounded repository scope
 *     ↓ the agent reads code it was pointed at         discoveryInstruction
 *     ↓ it writes one KnowledgeDelta                   (Phase 3, unchanged)
 *     ↓ Argus checks what it can check                 checkDiscoveryDelta
 *     ↓ the gate shows the candidates                  previewKnowledgeDelta
 *     ↓ a person approves                              (Phase 3, unchanged)
 *     ↓ the delta commits atomically                   (Phase 3, unchanged)
 *   canonical business rules
 *
 * The line this module draws, and never crosses:
 *
 * - **Argus validates structure.** Does this rule carry evidence? Does the
 *   path exist, inside the declared scope, at the commit the run actually ran
 *   on? Is the range a range? Is the revision precondition still current? All
 *   decided from the delta, the ledger and the filesystem — never by asking a
 *   model, and never by comparing two statements for similarity.
 * - **The human decides meaning.** Whether `Substring(0, 180)` really encodes
 *   "Kobra bookings restrict customer comments to 180 characters", or is an
 *   implementation accident, is interpretation. Argus has no way to know, and
 *   pretending otherwise is how an agent's guess becomes organizational truth.
 *   That is the whole reason a discovery phase is gated.
 *
 * Nothing here can write the ledger, and nothing here is a second acceptance
 * path: a discovery delta is an ordinary staged KnowledgeDelta and becomes
 * canonical through exactly the Phase 3 commit boundary.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRef,
  ClaimKind,
  ClaimRef,
  DeltaClaimRef,
  DiscoveryPolicy,
  DiscoveryScope,
  DiscoverySummary,
  EvidenceSource,
  KnowledgeDelta,
  KnowledgeDeltaPreview,
  KnowledgeDeltaRecord,
  KnowledgeDeltaWarning,
  KnowledgeDeltaWarningCode,
  PreviewClaim,
  PreviewEvidence,
  PreviewJustification,
  PreviewRef,
  PreviewRevision,
  SourceCodeEvidence,
  SupportDirection,
} from "@argus/contracts";
import {
  activeRevision,
  evaluateSupport,
  formatClaimRef,
  getClaim,
  lifecycleOf,
  validArtifactPath,
  type KnowledgeLedger,
} from "./kernel.js";

/** Most paths one discovery scope may name. A scope is a bounded target, not
 *  a repository listing. */
export const DISCOVERY_SCOPE_MAX_PATHS = 32;
export const DISCOVERY_LABEL_MAX_CHARS = 120;
export const DISCOVERY_NOTE_MAX_CHARS = 1000;

// ── The agent-facing contract ───────────────────────────────────────────────

/**
 * The reusable discovery instructions — the one place the "what is a business
 * rule?" contract is written, so an authored pipeline never has to restate it.
 *
 * Deliberately short. It says what to look for, what *not* to turn into a
 * rule, that evidence is mandatory, how to be honest about an assumption, and
 * that an existing rule is revised rather than duplicated. Everything else —
 * the delta's shape, local ids, exact refs — is already in
 * `KNOWLEDGE_DELTA_CONTRACT`, which every step receives in its system prompt;
 * repeating it here would only give the model two versions to reconcile.
 *
 * The per-phase parts (the scope, the label, whether evidence is required)
 * are appended by {@link discoveryInstruction}; this constant stays pure so
 * it reads the same in every prompt.
 */
export const DISCOVERY_CONTRACT = [
  "Business-rule discovery. This phase's job is to read the repository scope named below and",
  "propose the business rules it appears to enforce, as a KnowledgeDelta. You are proposing",
  "candidates for human review, not recording facts: nothing you write becomes canonical until",
  "this phase is approved.",
  "",
  "What to propose:",
  '- business-rule — a domain constraint the business would recognise: "Kobra bookings allow a',
  '  maximum customer comment length of 180 characters."',
  "- constraint — a technical or regulatory limit the domain must respect.",
  "- fact — something about the system that is simply the case and that later work must know.",
  "- assumption — your interpretation where the code does not establish it. Say so explicitly as",
  "  an assumption claim; do not smuggle uncertainty into a rule's wording.",
  "- conclusion — only where it follows from premises you also state, joined by a justification.",
  "",
  "What is NOT a business rule:",
  '- an implementation observation. "KobraBookingMapper.cs calls Substring(0, 180)" is evidence',
  "  FOR a rule; it is not itself one. Attach it as source-code evidence and state the rule the",
  "  code appears to enforce.",
  '- a naming or structural detail ("the class is called FooValidator").',
  "- an architectural preference, a style rule, or a test's implementation detail.",
  "- every conditional you find. Ask: what business or domain behaviour does this code appear to",
  "  enforce? If the answer is 'none, it is plumbing', propose nothing.",
  "",
  "Evidence is mandatory. Every business rule you propose must carry at least one supporting",
  'source-code evidence record: {"type":"source-code","path":"<repository-relative path>",',
  '"gitHead":"<the commit you read>","symbol":"<symbol, if known>","startLine":N,"endLine":M,',
  'with an optional short "note"}. Record where the code is, never a copy of it: paths and line',
  "ranges, not snippets. Paths must be repository-relative and inside the scope below.",
  "",
  "Existing rules. If you were supplied canonical claims as semantic context, check them first.",
  "When your evidence contradicts or updates one of them, propose a REVISION of that exact claim",
  '(revisions: [{"claimId":"RULE-17","expectedRevision":1,"statement":"...","localId":"r",',
  '"revisionNote":"why"}]) and attach your new evidence to its localId — do not create a second',
  "rule saying something different about the same thing. A revision that only rewords the",
  "sentence, with no new evidence, is refused.",
  "",
  "Assumptions. Where evidence is suggestive but not conclusive, propose the assumption as its own",
  "claim, attach what evidence you have to it, and justify the rule from the assumption plus the",
  "rest of your evidence. That way a reviewer can reject the assumption without losing the",
  "observation.",
  "",
  "Do not invent canonical ids, do not claim more certainty than your evidence carries, and do not",
  "propose rules about code outside the scope.",
].join("\n");

/** How one scope path reads in a prompt. */
function scopeLine(scope: DiscoveryScope): string {
  return scope.paths.map((p) => (p === "." ? "the whole working tree" : p)).join(", ");
}

/**
 * The prompt block a discovery step gets: the fixed contract plus this
 * phase's bounded scope. Appended after the author's own prompt, like the
 * artifact and result instructions, so the author says *what question to
 * answer* and Argus says *what the protocol is*.
 */
export function discoveryInstruction(policy: DiscoveryPolicy | undefined): string {
  if (!policy) return "";
  const { scope } = policy;
  const label = scope.label ? ` (${scope.label})` : "";
  const note = scope.note ? `\n${scope.note}` : "";
  const evidence =
    policy.evidence === "warn"
      ? "A rule proposed without evidence is flagged for the reviewer."
      : "A business rule proposed without supporting evidence is refused and fails this step.";
  return (
    `\n\n${DISCOVERY_CONTRACT}\n\n` +
    `Scope for this invocation${label}: ${scopeLine(scope)}. Investigate only these paths, ` +
    `relative to your working directory. ${evidence}${note}`
  );
}

// ── Scope and source-path rules ─────────────────────────────────────────────

/** A scope path, normalized: no trailing slash, `""` and `"./"` collapsed to `"."`. */
function normalizeScopePath(p: string): string {
  const trimmed = p.trim().replace(/\/+$/, "");
  return trimmed === "" || trimmed === "." ? "." : trimmed;
}

/**
 * Is a repository-relative path inside the declared scope?
 *
 * Prefix containment on whole path segments, so `src/Kobra` never matches
 * `src/KobraLegacy.cs`. A scope entry of `"."` admits the whole tree, which
 * an author has to write out — the default is not "everywhere".
 */
export function withinScope(scope: DiscoveryScope, relPath: string): boolean {
  return scope.paths.some((raw) => {
    const sp = normalizeScopePath(raw);
    if (sp === ".") return true;
    return relPath === sp || relPath.startsWith(`${sp}/`);
  });
}

/**
 * Do two commit shas name the same commit, allowing either to be abbreviated?
 *
 * Argus records `git rev-parse HEAD` (40 hex) for the run; an agent may well
 * write the short form it saw in a log. One being a prefix of the other is
 * the honest comparison, and the comparison is case-insensitive because git
 * prints lowercase but people paste anything.
 */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

const isLocal = (r: DeltaClaimRef): r is { local: string } => "local" in r;
const isSourceCode = (s: EvidenceSource): s is SourceCodeEvidence => s.type === "source-code";

/** Every `source-code` evidence record in a delta, with where it sits. */
function sourceEvidence(
  delta: KnowledgeDelta,
): Array<{ index: number; source: SourceCodeEvidence; claim: DeltaClaimRef }> {
  return (delta.evidence ?? []).flatMap((e, index) =>
    isSourceCode(e.source) ? [{ index, source: e.source, claim: e.claim }] : [],
  );
}

// ── Deterministic checks ────────────────────────────────────────────────────

/** What a discovery check needs to know about the run that wrote the delta. */
export interface DiscoveryContext {
  policy: DiscoveryPolicy;
  /** The working tree the run ran in — its worktree, else the phase's `cwd`.
   *  Null when Argus has no root to check against, which makes file existence
   *  unverifiable (and is reported as such rather than passed). */
  repoRoot: string | null;
  /** `git rev-parse HEAD` as Argus recorded it at launch, when the tree is a
   *  repository. Null = no recorded head; an agent-supplied `gitHead` is then
   *  accepted as unverifiable rather than refused. */
  gitHead: string | null;
}

function warn(
  code: KnowledgeDeltaWarningCode,
  subject: string,
  message: string,
): KnowledgeDeltaWarning {
  return { code, subject, message };
}

/**
 * The structural half of the source-evidence rules: path containment, the
 * declared scope, the line range and the commit. Pure — no filesystem — so it
 * can run anywhere, including in the preview a reviewer reads long after the
 * worktree is gone.
 */
export function checkSourceEvidenceShape(
  delta: KnowledgeDelta,
  ctx: Pick<DiscoveryContext, "policy" | "gitHead">,
): KnowledgeDeltaWarning[] {
  const out: KnowledgeDeltaWarning[] = [];
  for (const { source } of sourceEvidence(delta)) {
    const where = source.path;
    if (!validArtifactPath(source.path)) {
      out.push(
        warn(
          "source-path-unsafe",
          where,
          `source-code evidence path "${source.path}" is not a repository-relative path inside the repository`,
        ),
      );
      continue;
    }
    if (!withinScope(ctx.policy.scope, source.path)) {
      out.push(
        warn(
          "source-outside-scope",
          where,
          `source-code evidence path "${source.path}" is outside this phase's discovery scope (${scopeLine(ctx.policy.scope)})`,
        ),
      );
    }
    if (
      source.startLine !== undefined &&
      source.endLine !== undefined &&
      source.endLine < source.startLine
    ) {
      out.push(
        warn(
          "source-range-invalid",
          where,
          `source-code evidence for "${source.path}" has endLine ${source.endLine} before startLine ${source.startLine}`,
        ),
      );
    }
    if (source.gitHead && ctx.gitHead && !sameCommit(ctx.gitHead, source.gitHead)) {
      out.push(
        warn(
          "source-git-head-mismatch",
          where,
          `source-code evidence for "${source.path}" names commit ${source.gitHead}, but the run was recorded at ${ctx.gitHead}`,
        ),
      );
    }
  }
  return out;
}

/**
 * The filesystem half: every `source-code` path a discovery delta names must
 * exist as a file in the run's working tree.
 *
 * **Fail-closed.** A rule whose evidence points at a file that is not there is
 * a rule nobody can check, and the cheapest moment to notice is before it
 * becomes canonical. The same check runs at intake (while the worktree the run
 * used still exists) and again at the commit boundary, exactly as the artifact
 * check does, so a file deleted while a gate waited refuses the commit rather
 * than being recorded as provenance for something that is gone.
 *
 * Resolution is containment-checked a second time against the resolved
 * absolute path, so a path that somehow slipped past the syntactic rule cannot
 * reach outside the root here either.
 */
export async function checkSourceEvidenceFiles(
  delta: KnowledgeDelta,
  repoRoot: string | null,
): Promise<KnowledgeDeltaWarning[]> {
  const records = sourceEvidence(delta);
  if (records.length === 0 || !repoRoot) return [];
  const root = path.resolve(repoRoot);
  const out: KnowledgeDeltaWarning[] = [];
  const seen = new Set<string>();
  for (const { source } of records) {
    if (seen.has(source.path) || !validArtifactPath(source.path)) continue;
    seen.add(source.path);
    const resolved = path.resolve(root, ...source.path.split("/"));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      out.push(
        warn(
          "source-path-unsafe",
          source.path,
          `source-code evidence path "${source.path}" resolves outside the run's repository`,
        ),
      );
      continue;
    }
    try {
      const st = await stat(resolved);
      if (!st.isFile()) {
        out.push(
          warn(
            "source-file-missing",
            source.path,
            `source-code evidence path "${source.path}" is not a file in the run's repository`,
          ),
        );
      }
    } catch {
      out.push(
        warn(
          "source-file-missing",
          source.path,
          `source-code evidence path "${source.path}" does not exist in the run's repository`,
        ),
      );
    }
  }
  return out;
}

/** What in the delta bears on a claim: does it have supporting evidence, a
 *  justification concluding it? */
function supportOf(delta: KnowledgeDelta, target: DeltaClaimRef) {
  const same = (a: DeltaClaimRef) =>
    isLocal(a) && isLocal(target)
      ? a.local === target.local
      : !isLocal(a) && !isLocal(target) && a.id === target.id && a.revision === target.revision;
  return {
    evidence: (delta.evidence ?? []).filter(
      (e) => same(e.claim) && (e.direction ?? "supports") === "supports",
    ),
    justifications: (delta.justifications ?? []).filter(
      (j) => same(j.conclusion) && (j.direction ?? "supports") === "supports",
    ),
  };
}

/**
 * Everything deterministic that can be said about a delta's *semantics* —
 * evidence coverage, revision targets, the duplicate-rule prompt — from the
 * delta and the ledger alone.
 *
 * `ledger` may be a snapshot with the delta's targets missing (a hand-built
 * preview, a pruned test fixture); every ledger lookup degrades to "say
 * nothing" rather than throwing, because a preview must never fail.
 */
export function semanticWarnings(
  delta: KnowledgeDelta,
  ledger: KnowledgeLedger | null,
  opts: { supplied?: ClaimRef[] } = {},
): KnowledgeDeltaWarning[] {
  const out: KnowledgeDeltaWarning[] = [];

  for (const c of delta.claims ?? []) {
    const ref: DeltaClaimRef = { local: c.localId };
    const { evidence, justifications } = supportOf(delta, ref);
    const label = `local:${c.localId}`;
    if (c.kind === "business-rule" && evidence.length === 0) {
      out.push(
        warn(
          "business-rule-without-evidence",
          label,
          `business rule "${c.statement}" carries no supporting evidence`,
        ),
      );
    } else if (c.kind === "assumption" && evidence.length === 0 && justifications.length === 0) {
      out.push(
        warn(
          "assumption-without-evidence",
          label,
          `assumption "${c.statement}" carries neither evidence nor a justification; a reviewer is being asked to take it on trust`,
        ),
      );
    } else if (
      c.kind !== "business-rule" &&
      c.kind !== "assumption" &&
      evidence.length === 0 &&
      justifications.length === 0
    ) {
      out.push(
        warn(
          "claim-without-support",
          label,
          `${c.kind} "${c.statement}" carries neither evidence nor a justification`,
        ),
      );
    }
  }

  for (const rev of delta.revisions ?? []) {
    const label = rev.claimId;
    const active = ledger ? activeRevision(ledger, rev.claimId) : null;
    if (active && active.revision !== rev.expectedRevision) {
      out.push(
        warn(
          "revision-stale",
          label,
          `${rev.claimId} expects v${rev.expectedRevision} but the active revision is v${active.revision}; the commit will refuse this delta`,
        ),
      );
    }
    if (ledger && active) {
      const support = evaluateSupport(ledger, { id: active.id, revision: active.revision });
      if (support !== "supported") {
        out.push(
          warn(
            "revision-target-unsupported",
            label,
            `${formatClaimRef({ id: active.id, revision: active.revision })} is currently ${support}`,
          ),
        );
      }
    }
    // A business-rule revision must bring its own evidence. Reworded rules
    // with no new observation behind them are exactly what the ledger is for
    // refusing: the sentence changed, the grounds did not.
    const kind = active?.kind;
    if (kind === "business-rule") {
      const evidence = rev.localId
        ? supportOf(delta, { local: rev.localId }).evidence
        : ([] as unknown[]);
      if (evidence.length === 0) {
        out.push(
          warn(
            "revision-without-evidence",
            label,
            rev.localId
              ? `the proposed revision of ${rev.claimId} carries no supporting evidence for its new statement`
              : `the proposed revision of ${rev.claimId} declares no localId, so no evidence in this delta can support its new statement`,
          ),
        );
      }
    }
  }

  // The duplicate-rule prompt. Structural, never semantic: the run was given
  // business rules as context and is creating a new one without revising any
  // of them. Argus does not claim they are the same rule — it has no way to
  // know and deliberately does not guess (no embeddings, no similarity). It
  // says only that a reviewer should check, which is the one thing that is
  // actually true.
  const suppliedRules = (opts.supplied ?? []).filter(
    (r) => ledger && getClaim(ledger, r)?.kind === "business-rule",
  );
  const newRules = (delta.claims ?? []).filter((c) => c.kind === "business-rule");
  const revisedIds = new Set((delta.revisions ?? []).map((r) => r.claimId));
  const unrevised = suppliedRules.filter((r) => !revisedIds.has(r.id));
  if (newRules.length > 0 && unrevised.length > 0) {
    out.push(
      warn(
        "new-rule-while-rules-supplied",
        newRules.map((c) => `local:${c.localId}`).join(", "),
        `this delta creates ${newRules.length} new business rule${newRules.length === 1 ? "" : "s"} while ${unrevised.length} supplied business rule${unrevised.length === 1 ? " was" : "s were"} left unrevised (${unrevised.map(formatClaimRef).join(", ")}); check whether one of them is the same logical rule, which should be revised rather than duplicated`,
      ),
    );
  }
  return out;
}

/**
 * Which warnings refuse a discovery delta outright, rather than merely
 * flagging it for the reviewer.
 *
 * Everything Argus can *prove* wrong about the proposal's grounds is fatal:
 * a rule with no evidence, a source path that is unsafe, out of scope,
 * missing, at the wrong commit, or an impossible range. Everything that is a
 * judgement call for a person — an unsupported target, a bare assumption, a
 * possible duplicate — is a warning, because refusing it would be Argus
 * deciding the semantics, which is the reviewer's job.
 *
 * `evidence: "warn"` downgrades the two evidence-coverage codes and nothing
 * else: an author may choose to see a rule with no evidence at the gate, but
 * nobody gets to choose to record evidence pointing at a file that is not
 * there.
 */
export function fatalDiscoveryWarnings(
  warnings: KnowledgeDeltaWarning[],
  policy: DiscoveryPolicy,
): KnowledgeDeltaWarning[] {
  const evidenceRequired = policy.evidence !== "warn";
  return warnings.filter((w) => {
    switch (w.code) {
      case "business-rule-without-evidence":
      case "revision-without-evidence":
        return evidenceRequired;
      case "source-path-unsafe":
      case "source-outside-scope":
      case "source-file-missing":
      case "source-git-head-mismatch":
      case "source-range-invalid":
        return true;
      default:
        return false;
    }
  });
}

/** Every deterministic warning over a discovery delta: shape, filesystem and
 *  semantics, in that order so a reader sees the concrete problems first. */
export async function discoveryWarnings(
  delta: KnowledgeDelta,
  ledger: KnowledgeLedger | null,
  ctx: DiscoveryContext,
  supplied?: ClaimRef[],
): Promise<KnowledgeDeltaWarning[]> {
  return [
    ...checkSourceEvidenceShape(delta, ctx),
    ...(await checkSourceEvidenceFiles(delta, ctx.repoRoot)),
    ...semanticWarnings(delta, ledger, { supplied: supplied ?? [] }),
  ];
}

/**
 * The one sentence a refused discovery delta carries, or null when it may be
 * staged. Warnings that are not fatal are not in it: they travel to the gate
 * on the preview, where a person can weigh them.
 */
export async function checkDiscoveryDelta(
  delta: KnowledgeDelta,
  ledger: KnowledgeLedger | null,
  ctx: DiscoveryContext,
  supplied?: ClaimRef[],
): Promise<{ warnings: KnowledgeDeltaWarning[]; refusal: string | null }> {
  const warnings = await discoveryWarnings(delta, ledger, ctx, supplied);
  const fatal = fatalDiscoveryWarnings(warnings, ctx.policy);
  return {
    warnings,
    refusal: fatal.length === 0 ? null : `discovery: ${fatal.map((f) => f.message).join("; ")}`,
  };
}

// ── The candidate preview ───────────────────────────────────────────────────

const previewLocal = (local: string): PreviewRef => ({ display: `local:${local}`, local });

function previewExact(claim: ClaimRef, proposed = false): PreviewRef {
  return {
    display: proposed ? `${formatClaimRef(claim)} (proposed)` : formatClaimRef(claim),
    claim: { id: claim.id, revision: claim.revision },
    ...(proposed ? { proposed: true } : {}),
  };
}

function previewRef(r: DeltaClaimRef): PreviewRef {
  return isLocal(r) ? previewLocal(r.local) : previewExact(r);
}

function previewEvidence(e: {
  claim: DeltaClaimRef;
  direction?: SupportDirection;
  source: EvidenceSource;
  note?: string;
}): PreviewEvidence {
  return {
    claim: previewRef(e.claim),
    direction: e.direction ?? "supports",
    source: e.source,
    ...(e.note !== undefined ? { note: e.note } : {}),
  };
}

function previewJustification(j: {
  conclusion: DeltaClaimRef;
  premises: DeltaClaimRef[];
  direction?: SupportDirection;
  note?: string;
}): PreviewJustification {
  return {
    conclusion: previewRef(j.conclusion),
    premises: j.premises.map(previewRef),
    direction: j.direction ?? "supports",
    ...(j.note !== undefined ? { note: j.note } : {}),
  };
}

function describeExisting(ledger: KnowledgeLedger | null, ref: ClaimRef) {
  const claim = ledger ? getClaim(ledger, ref) : null;
  return {
    ref: formatClaimRef(ref),
    claim: { id: ref.id, revision: ref.revision },
    ...(claim ? { kind: claim.kind, statement: claim.statement } : {}),
  };
}

/**
 * The deterministic read model of one staged delta (Phase 5 §candidate
 * preview): what a reviewer needs in order to decide, without reading the
 * agent's transcript.
 *
 * Three things it takes care to do honestly:
 *
 * - **It does not invent canonical identity.** A proposed claim is
 *   `local:comment-limit`, because that is all it is until the commit mints
 *   an id. Pretending otherwise would put an id in a reviewer's head that no
 *   ledger will ever hold if the gate is revised.
 * - **It says what a revision would replace.** `current` is the active
 *   revision as the ledger stands right now, so the gate shows before and
 *   after rather than a sentence with no anchor.
 * - **It mutates nothing.** Purely derived, per read, from the staged record
 *   and a ledger snapshot.
 *
 * `warnings` is whatever the caller computed (the engine passes the full
 * discovery set, including the filesystem checks); the semantic warnings are
 * recomputed here when none are supplied, so a preview is useful even on a
 * non-discovery delta.
 */
export function previewKnowledgeDelta(
  record: KnowledgeDeltaRecord,
  ledger: KnowledgeLedger | null,
  warnings?: KnowledgeDeltaWarning[],
): KnowledgeDeltaPreview {
  const delta: KnowledgeDelta = record.delta ?? { schemaVersion: 1 };
  const evidence = (delta.evidence ?? []).map(previewEvidence);
  const justifications = (delta.justifications ?? []).map(previewJustification);
  const forLocal = (local: string) => ({
    evidence: evidence.filter((e) => e.claim.local === local),
    justifications: justifications.filter((j) => j.conclusion.local === local),
  });

  const proposedClaims: PreviewClaim[] = (delta.claims ?? []).map((c) => ({
    ref: previewLocal(c.localId),
    kind: c.kind,
    statement: c.statement,
    ...(c.structuredValue !== undefined ? { structuredValue: c.structuredValue } : {}),
    ...forLocal(c.localId),
  }));

  const proposedRevisions: PreviewRevision[] = (delta.revisions ?? []).map((rev) => {
    const active = ledger ? activeRevision(ledger, rev.claimId) : null;
    const next: ClaimRef = { id: rev.claimId, revision: rev.expectedRevision + 1 };
    const attached = rev.localId ? forLocal(rev.localId) : { evidence: [], justifications: [] };
    return {
      claimId: rev.claimId,
      expectedRevision: rev.expectedRevision,
      ref: previewExact(next, true),
      ...(active ? { kind: active.kind } : {}),
      statement: rev.statement,
      ...(rev.revisionNote !== undefined ? { revisionNote: rev.revisionNote } : {}),
      ...(rev.structuredValue !== undefined ? { structuredValue: rev.structuredValue } : {}),
      ...(active && ledger
        ? {
            current: {
              claim: { id: active.id, revision: active.revision },
              statement: active.statement,
              support: evaluateSupport(ledger, { id: active.id, revision: active.revision }),
              lifecycle: lifecycleOf(ledger, { id: active.id, revision: active.revision }),
            },
          }
        : {}),
      ...(active && active.revision !== rev.expectedRevision ? { stale: true } : {}),
      ...attached,
    };
  });

  const artifacts: ArtifactRef[] = (delta.artifacts ?? []).map((a) => ({ ...a }));
  return {
    deltaId: record.id,
    runId: record.runId,
    step: record.step,
    attempt: record.attempt,
    status: record.status,
    proposedClaims,
    proposedRevisions,
    evidence,
    justifications,
    consumed: (delta.consumed ?? []).map((c) => describeExisting(ledger, c)),
    artifacts,
    ...(record.supplied
      ? { supplied: record.supplied.map((c) => describeExisting(ledger, c)) }
      : {}),
    ...(delta.metadata?.summary !== undefined ? { summary: delta.metadata.summary } : {}),
    warnings: warnings ?? semanticWarnings(delta, ledger, { supplied: record.supplied ?? [] }),
  };
}

// ── The phase's structured summary ──────────────────────────────────────────

const countKind = (delta: KnowledgeDelta, kind: ClaimKind): number =>
  (delta.claims ?? []).filter((c) => c.kind === kind).length;

/**
 * The counts a discovery phase reports (Phase 5 §17): enough for routing,
 * status and observability, and deliberately *not* a second copy of the
 * candidates. The proposal itself stays in the staged KnowledgeDelta, which
 * is the one authoritative form of it.
 */
export function summarizeDiscovery(
  previews: KnowledgeDeltaPreview[],
  deltas: KnowledgeDelta[],
  requiresReview: boolean,
): DiscoverySummary {
  const sum = (f: (d: KnowledgeDelta) => number) => deltas.reduce((n, d) => n + f(d), 0);
  return {
    candidates: sum((d) => (d.claims?.length ?? 0) + (d.revisions?.length ?? 0)),
    newRules: sum((d) => countKind(d, "business-rule")),
    revisions: sum((d) => d.revisions?.length ?? 0),
    assumptions: sum((d) => countKind(d, "assumption")),
    facts: sum((d) => countKind(d, "fact")),
    constraints: sum((d) => countKind(d, "constraint")),
    conclusions: sum((d) => countKind(d, "conclusion")),
    evidence: sum((d) => d.evidence?.length ?? 0),
    warnings: previews.reduce((n, p) => n + p.warnings.length, 0),
    requiresReview,
  };
}
