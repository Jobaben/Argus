/**
 * Knowledge scope — who owns a piece of knowledge, and what a run may see.
 *
 * Argus keeps one authoritative ledger. It must nevertheless be able to run
 * pipelines against wholly unrelated projects without either of them
 * traversing, materializing or being told about the other's knowledge. This
 * module is the whole of that boundary:
 *
 *   PipelineDefinition.knowledgeScope        author-declared project identity
 *          ↓ resolveKnowledgeScope(policy, cwd)
 *   KnowledgeScope { projectId, repositoryId }   frozen on the phase attempt
 *          ↓ qualifyClaimId / claimsInScope / justificationsInScope
 *   scoped lookups, scoped traversal, scoped context
 *
 * Three decisions carry it, and each one is the answer to a specific way the
 * naive design goes wrong:
 *
 * - **Identity is declared and derived, never a path.** `C:\src\Kobra`,
 *   `/home/u/src/Kobra` and a `/worktrees/poc` worktree are one repository.
 *   {@link resolveRepositoryId} asks git for the normalized remote, else the
 *   root commit — both identical across clones, checkouts and machines — and
 *   refuses rather than falling back to the directory name.
 *
 * - **The scope is folded into the canonical claim id.** Every edge in the
 *   ledger (evidence, premise, consumption, verification, semantic change)
 *   names a bare `ClaimRef`. If ids were only unique *within* a scope, every
 *   one of those refs would become ambiguous and the graph would have to carry
 *   a scope on each edge. Instead `RULE-42` created in scope S becomes
 *   `RULE-42.<8 hex of S>`: two unrelated repositories can each hold a
 *   `RULE-42`, ids stay globally unique, and every existing ref-keyed lookup
 *   is *already* isolated. The stored {@link KnowledgeScope} on the claim
 *   remains the authoritative, queryable ownership — the token is a naming
 *   device, never the thing scope checks read.
 *
 * - **Absent means unknown, and unknown is never adopted.** A claim written
 *   before scopes existed, or by a pipeline that declares none, has no scope.
 *   A scoped query never returns it and a scoped pipeline can never resolve
 *   it; an unscoped pipeline behaves exactly as it did before this module
 *   existed. Nothing here backfills ownership Argus cannot prove.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Claim, Evidence, Justification, KnowledgeScope } from "@argus/contracts";
import { KnowledgeValidationError } from "./errors.js";

/** A project id: author-declared, so the alphabet is the one every other Argus
 *  identifier uses. */
export const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A repository id. Wider than a project id because a derived one carries a
 *  scheme and a host path (`git:github.com/acme/kobra`), and deliberately
 *  excludes whitespace, backslashes and drive letters so a filesystem path can
 *  never be mistaken for one. */
export const REPOSITORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;

/** How many `alsoRead` scopes one pipeline may declare. Cross-project reading
 *  is meant to be a named exception, not a second way of saying "everything". */
export const ALSO_READ_MAX = 8;

/** The stable string form of a scope, and the key every scope index uses. */
export function scopeKey(scope: KnowledgeScope): string {
  return `${scope.projectId}/${scope.repositoryId}`;
}

/** The key of a possibly-absent scope. Unscoped records key to `""`, which is
 *  a real bucket of its own and never merges with a declared one. */
export function scopeKeyOf(scope: KnowledgeScope | undefined): string {
  return scope ? scopeKey(scope) : "";
}

/** Scope equality, including "both unscoped". Never treats an unscoped record
 *  as belonging to a scope, nor the reverse. */
export function sameScope(a: KnowledgeScope | undefined, b: KnowledgeScope | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.projectId === b.projectId && a.repositoryId === b.repositoryId;
}

/** A scope with only its two fields, for persisting. */
export function plainScope(scope: KnowledgeScope): KnowledgeScope {
  return { projectId: scope.projectId, repositoryId: scope.repositoryId };
}

/** `project-a/git:github.com/acme/kobra` → `4f3a9c17`. Deterministic, so the
 *  same scope always qualifies ids the same way on every machine, and
 *  independent of creation order — unlike "first project keeps the pretty id". */
export function scopeToken(scope: KnowledgeScope): string {
  return createHash("sha256").update(scopeKey(scope), "utf8").digest("hex").slice(0, 8);
}

/** The longest local part a claim id may have once its scope token is appended
 *  (`CLAIM_ID_RE` allows 80 characters, and the suffix costs 9). */
export const LOCAL_CLAIM_ID_MAX = 71;

/**
 * The canonical id of a claim created in `scope` from the local name `local`.
 *
 * Unscoped claims keep their name exactly — which is what makes every ledger
 * written before this module existed read back unchanged.
 */
export function qualifyClaimId(local: string, scope: KnowledgeScope | undefined): string {
  if (!scope) return local;
  if (local.length > LOCAL_CLAIM_ID_MAX) {
    throw new KnowledgeValidationError(
      `claim id "${local}" is too long for a scoped claim (at most ${LOCAL_CLAIM_ID_MAX} characters before the scope suffix)`,
    );
  }
  return `${local}.${scopeToken(scope)}`;
}

/** The local name of a canonical id within `scope` — the inverse of
 *  {@link qualifyClaimId}, for display. Returns the id unchanged when it does
 *  not carry that scope's suffix. */
export function localClaimId(id: string, scope: KnowledgeScope | undefined): string {
  if (!scope) return id;
  const suffix = `.${scopeToken(scope)}`;
  return id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
}

// ── Scoped slices ────────────────────────────────────────────────────────────

/**
 * The records of one scope, computed once per ledger snapshot.
 *
 * Scope is the *first* lookup dimension: a scoped read takes its slice from
 * the index and then works on a list that already contains nothing else,
 * rather than filtering the whole ledger on every query. The index is built
 * lazily, once, and cached against the snapshot object itself — ledger
 * snapshots are immutable (`store.ts` replaces the document rather than
 * mutating it), so a cached index can never describe a document that has
 * moved on.
 */
export interface ScopeSlice {
  claims: Claim[];
  /** Every claim id owned by this scope. The membership test every other
   *  slice is derived from, since each edge names a claim. */
  claimIds: Set<string>;
  evidence: Evidence[];
  justifications: Justification[];
}

interface ScopeIndex {
  byKey: Map<string, ScopeSlice>;
}

/** Only the shape the index needs, so a test can index a hand-built object. */
interface IndexableLedger {
  claims: Claim[];
  evidence: Evidence[];
  justifications: Justification[];
}

const indexes = new WeakMap<object, ScopeIndex>();

function indexOf(ledger: IndexableLedger): ScopeIndex {
  const cached = indexes.get(ledger);
  if (cached) return cached;
  const byKey = new Map<string, ScopeSlice>();
  const slice = (key: string): ScopeSlice => {
    let s = byKey.get(key);
    if (!s) {
      s = { claims: [], claimIds: new Set(), evidence: [], justifications: [] };
      byKey.set(key, s);
    }
    return s;
  };
  for (const claim of ledger.claims) {
    const s = slice(scopeKeyOf(claim.scope));
    s.claims.push(claim);
    s.claimIds.add(claim.id);
  }
  // An edge belongs to the scope of the claim it is about. Evidence names one
  // claim; a justification is only ever created with every premise and its
  // conclusion in one scope (`addJustification` refuses otherwise), so its
  // conclusion decides. An edge whose claim the ledger does not hold — only
  // reachable by hand-editing the file — belongs to no scope and is therefore
  // returned by no scoped read, which is the fail-closed answer.
  const owner = new Map<string, string>();
  for (const claim of ledger.claims) owner.set(claim.id, scopeKeyOf(claim.scope));
  for (const e of ledger.evidence) {
    const key = owner.get(e.claim.id);
    if (key !== undefined) slice(key).evidence.push(e);
  }
  for (const j of ledger.justifications) {
    const key = owner.get(j.conclusion.id);
    if (key !== undefined) slice(key).justifications.push(j);
  }
  const index: ScopeIndex = { byKey };
  indexes.set(ledger, index);
  return index;
}

const EMPTY: ScopeSlice = Object.freeze({
  claims: Object.freeze([]) as unknown as Claim[],
  claimIds: new Set<string>(),
  evidence: Object.freeze([]) as unknown as Evidence[],
  justifications: Object.freeze([]) as unknown as Justification[],
});

/** The slice of one scope, in ledger order. O(1) after the first call on a
 *  snapshot. `undefined` asks for the unscoped records, which is a scope of
 *  its own and never a wildcard. */
export function sliceOfScope(
  ledger: IndexableLedger,
  scope: KnowledgeScope | undefined,
): ScopeSlice {
  return indexOf(ledger).byKey.get(scopeKeyOf(scope)) ?? EMPTY;
}

/** The union of several scopes' slices, in ledger order within each. Used for
 *  an explicitly authorized cross-scope read; with one scope it is the slice. */
export function claimsInScopes(
  ledger: IndexableLedger,
  scopes: Array<KnowledgeScope | undefined>,
): Claim[] {
  if (scopes.length === 1) return sliceOfScope(ledger, scopes[0]).claims;
  const seen = new Set<string>();
  const out: Claim[] = [];
  for (const scope of scopes) {
    const key = scopeKeyOf(scope);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(...sliceOfScope(ledger, scope).claims);
  }
  return out;
}

/** Is this exact claim id owned by one of `scopes`? The membership test every
 *  scope check uses; never a string-suffix guess. */
export function claimIdInScopes(
  ledger: IndexableLedger,
  id: string,
  scopes: Array<KnowledgeScope | undefined>,
): boolean {
  return scopes.some((s) => sliceOfScope(ledger, s).claimIds.has(id));
}

/** The scope a claim id belongs to, or null when the ledger does not hold it.
 *  Undefined is a legitimate answer (an unscoped claim), so the two cases are
 *  distinguished rather than collapsed. */
export function scopeOfClaimId(
  ledger: IndexableLedger,
  id: string,
): { scope: KnowledgeScope | undefined } | null {
  const claim = ledger.claims.find((c) => c.id === id);
  return claim ? { scope: claim.scope } : null;
}

// ── Authoring ────────────────────────────────────────────────────────────────

/** The declared policy, validated. Ledger-independent, so a malformed one is
 *  refused when the pipeline is saved rather than when it launches. */
export interface KnowledgeScopePolicyValue {
  projectId: string;
  repositoryId?: string;
  alsoRead?: KnowledgeScope[];
}

function fail(msg: string): never {
  throw new KnowledgeValidationError(msg);
}

function scopeValue(raw: unknown, ctx: string): KnowledgeScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${ctx} must be an object { projectId, repositoryId }`);
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== "projectId" && k !== "repositoryId") fail(`${ctx} has unknown key "${k}"`);
  }
  if (typeof r.projectId !== "string" || !PROJECT_ID_RE.test(r.projectId)) {
    fail(`${ctx}.projectId must be a project id (letters, digits, ".", "_", "-")`);
  }
  if (typeof r.repositoryId !== "string" || !REPOSITORY_ID_RE.test(r.repositoryId)) {
    fail(`${ctx}.repositoryId must be a repository id, never a filesystem path`);
  }
  return { projectId: r.projectId, repositoryId: r.repositoryId };
}

/** Untrusted authoring → a validated policy. */
export function parseKnowledgeScopePolicy(raw: unknown): KnowledgeScopePolicyValue {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("knowledgeScope must be an object { projectId, repositoryId?, alsoRead? }");
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== "projectId" && k !== "repositoryId" && k !== "alsoRead") {
      fail(`knowledgeScope has unknown key "${k}"`);
    }
  }
  if (typeof r.projectId !== "string" || !PROJECT_ID_RE.test(r.projectId)) {
    fail('knowledgeScope.projectId must be a project id (letters, digits, ".", "_", "-")');
  }
  const out: KnowledgeScopePolicyValue = { projectId: r.projectId };
  if (r.repositoryId !== undefined && r.repositoryId !== null) {
    if (typeof r.repositoryId !== "string" || !REPOSITORY_ID_RE.test(r.repositoryId)) {
      fail("knowledgeScope.repositoryId must be a repository id, never a filesystem path");
    }
    out.repositoryId = r.repositoryId;
  }
  if (r.alsoRead !== undefined && r.alsoRead !== null) {
    if (!Array.isArray(r.alsoRead)) fail("knowledgeScope.alsoRead must be a list of scopes");
    if (r.alsoRead.length > ALSO_READ_MAX) {
      fail(`knowledgeScope.alsoRead may name at most ${ALSO_READ_MAX} scopes`);
    }
    const scopes = r.alsoRead.map((v, i) => scopeValue(v, `knowledgeScope.alsoRead[${i}]`));
    const seen = new Set<string>();
    for (const s of scopes) {
      const key = scopeKey(s);
      if (seen.has(key)) fail(`knowledgeScope.alsoRead names ${key} twice`);
      seen.add(key);
    }
    out.alsoRead = scopes;
  }
  return out;
}

/** The policy in force for one phase: its own, else the pipeline's. A phase
 *  override *replaces* the pipeline's, exactly as a workspace policy does. */
export function knowledgeScopePolicyFor(
  def: { knowledgeScope?: KnowledgeScopePolicyValue },
  phaseDef: { knowledgeScope?: KnowledgeScopePolicyValue } | undefined,
): KnowledgeScopePolicyValue | undefined {
  return phaseDef?.knowledgeScope ?? def.knowledgeScope;
}

// ── Repository identity ──────────────────────────────────────────────────────

/**
 * A git remote URL → a durable repository identity, or null when the URL is
 * not one Argus can normalize.
 *
 * Every spelling of one repository collapses to one answer:
 *
 *   https://github.com/Acme/Kobra.git    ┐
 *   git@github.com:Acme/Kobra.git        ├→ git:github.com/acme/kobra
 *   ssh://git@github.com:22/Acme/Kobra   ┘
 *
 * A local path remote (`/srv/git/kobra.git`, `C:\mirrors\kobra`) returns null
 * on purpose: a path is exactly what must not become identity, and the caller
 * falls through to the root commit.
 */
export function normalizeRemoteRepositoryId(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  let rest: string;
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}):(?!\/)(.+)$/.exec(raw);
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(raw);
  if (scheme) {
    const proto = raw.slice(0, scheme[0].length - 3).toLowerCase();
    if (proto === "file") return null;
    let after = raw.slice(scheme[0].length);
    after = after.replace(/^[^@/]*@/, "");
    rest = after;
  } else if (scp) {
    rest = `${scp[1]}/${scp[2]}`;
  } else {
    return null;
  }
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const host = rest.slice(0, slash).replace(/:\d+$/, "").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && host !== "localhost") return null;
  let path = rest
    .slice(slash + 1)
    .replace(/\.git\/?$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (!path) return null;
  path = path.replace(/[^a-z0-9._/-]/g, "-");
  const id = `git:${host}/${path}`;
  return REPOSITORY_ID_RE.test(id) ? id : null;
}

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile("git", args, { cwd, timeout: 5000, windowsHide: true }, (err, stdout) =>
        resolve(err ? null : stdout.trim() || null),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * The durable identity of the repository a working tree belongs to, or null.
 *
 * Two derivations, in order, both of which a git *worktree* and any clone
 * answer identically to the main checkout:
 *
 *   1. the normalized `origin` remote — the identity people mean by "the repo";
 *   2. the root commit — an intrinsic fact about the history, for a repository
 *      that has no remote at all.
 *
 * Never the directory. A tree that answers neither gets null, and the caller
 * refuses the launch with a message telling the author to declare
 * `repositoryId` rather than quietly scoping the knowledge to a path.
 *
 * The root-commit form says exactly what it says: *the repository whose
 * history begins at this commit*. Two checkouts that share that commit share a
 * history — which is the intended answer for a clone, and is also why two
 * repositories deliberately initialized to byte-identical first commits would
 * be one identity. Git cannot tell them apart either. An author who knows
 * better declares `repositoryId`, which always wins over derivation.
 */
export async function resolveRepositoryId(cwd: string): Promise<string | null> {
  const remote = await git(["remote", "get-url", "origin"], cwd);
  if (remote) {
    const id = normalizeRemoteRepositoryId(remote);
    if (id) return id;
  }
  const roots = await git(["rev-list", "--max-parents=0", "HEAD"], cwd);
  if (roots) {
    // Several root commits (a grafted or octopus history) still identify the
    // repository, as long as the set is taken in a stable order.
    const sorted = roots
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{40}$/.test(l))
      .sort();
    if (sorted.length === 1) return `commit:${sorted[0]}`;
    if (sorted.length > 1) {
      return `commit:${createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex").slice(0, 40)}`;
    }
  }
  return null;
}

/** What a phase attempt resolved to: the scope it owns, and the scopes it may
 *  additionally read. */
export interface ResolvedKnowledgeScope {
  scope: KnowledgeScope;
  alsoRead: KnowledgeScope[];
}

/**
 * The declared policy plus the phase's working tree → the frozen scope.
 *
 * `repositoryId` is taken from the policy when the author declared one (they
 * know better than git does — a monorepo split, a mirror, a rename), and
 * derived otherwise. Failure is explicit and carries the reason, because the
 * alternative is scoping a project's knowledge to whatever the checkout
 * happened to be called.
 */
export async function resolveKnowledgeScope(
  policy: KnowledgeScopePolicyValue,
  cwd: string,
): Promise<{ ok: true; resolved: ResolvedKnowledgeScope } | { ok: false; reason: string }> {
  let repositoryId = policy.repositoryId;
  if (!repositoryId) {
    const derived = await resolveRepositoryId(cwd);
    if (!derived) {
      return {
        ok: false,
        reason:
          `knowledge scope: cannot derive a repository identity for "${cwd}" — it has no ` +
          '"origin" remote Argus can normalize and no reachable root commit. Declare ' +
          "knowledgeScope.repositoryId explicitly; Argus will not use the directory path as identity",
      };
    }
    repositoryId = derived;
  }
  const scope: KnowledgeScope = { projectId: policy.projectId, repositoryId };
  const alsoRead = (policy.alsoRead ?? []).filter((s) => !sameScope(s, scope)).map(plainScope);
  return { ok: true, resolved: { scope, alsoRead } };
}

/** A claim's scope as a refusal message names it. Kept beside {@link sameScope}
 *  so every scope refusal in the ledger reads the same way. */
export function describeScopeOfClaim(scope: KnowledgeScope | undefined): string {
  return scope ? `scope ${scopeKey(scope)}` : "no knowledge scope";
}

/** The scopes a run may read: its own first, then the ones it was explicitly
 *  authorized for. The order matters — an unqualified selector resolves in the
 *  run's own scope before any broader one. */
export function readableScopes(resolved: {
  scope?: KnowledgeScope;
  alsoRead?: KnowledgeScope[];
}): Array<KnowledgeScope | undefined> {
  return [resolved.scope, ...(resolved.alsoRead ?? [])];
}
