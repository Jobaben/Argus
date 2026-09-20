import { Hono, type Context } from "hono";
import type {
  AcceptanceConformanceReport,
  AcceptanceVerificationPreview,
  AcceptedChangeProposal,
  ArtifactProductionsResponse,
  ChangeRealizationResultsResponse,
  ChangeRealizationRunsResponse,
  ChangeRealizationView,
  ChangeRealizationsResponse,
  ChangeProposalPreview,
  ChangeProposalsResponse,
  ClaimDetail,
  ClaimKind,
  ClaimVerificationsResponse,
  ClaimsResponse,
  ConsumptionsResponse,
  ExecutionContextReport,
  ExecutionVerificationsResponse,
  KnowledgeDeltaPreview,
  KnowledgeDeltasResponse,
  KnowledgeScope,
  RuleConformanceReport,
  RuleVerificationPreview,
  SuppliedToReport,
} from "@argus/contracts";
import { readInvocation } from "../sources/runs.js";
import { compareSuppliedConsumed, readKnowledgeContext } from "./context.js";
import {
  CLAIM_ID_RE,
  CLAIM_KINDS,
  EXECUTION_ID_RE,
  KnowledgeValidationError,
  UnknownClaimError,
  changeProposalById,
  changeProposalOfClaim,
  changeProposals,
  changeProposalsForRequest,
  changeRealizationById,
  changeRealizations,
  changeRealizationsForProposal,
  acceptanceConformance,
  acceptanceVerificationsOfProposal,
  acceptanceVerificationsOfRun,
  consumersReport,
  realizationView,
  dependentsReport,
  executionOf,
  executionProvenance,
  parseClaimKey,
  refOf,
  resolveKey,
  revisionsOf,
  ruleConformance,
  scopeOfAcceptedChange,
  suppliedContextOf,
  suppliedToReport,
  supportReport,
  verificationsOfClaim,
  verificationsOfRun,
  viewOf,
  type KnowledgeLedger,
} from "./kernel.js";
import { analyzeImpact } from "./impact.js";
import {
  PROJECT_ID_RE,
  REPOSITORY_ID_RE,
  claimsInScopes,
  qualifyClaimId,
  sameScope,
} from "./scope.js";
import { previewKnowledgeDelta } from "./discovery.js";
import { readDeltaRecord, readDeltaRecordById } from "./staging.js";
import { readVerificationRecord, readVerificationRecordById } from "./verificationStaging.js";
import { previewRuleVerification } from "./ruleVerification.js";
import { readProposalRecord, readProposalRecordById } from "./changeStaging.js";
import { previewChangeProposal } from "./changeIntent.js";
import { readAcceptanceRecord, readAcceptanceRecordById } from "./acceptanceStaging.js";
import { previewAcceptance } from "./acceptance.js";
import {
  createClaim,
  createEvidence,
  createJustification,
  createRevision,
  readLedger,
  registerArtifacts,
  registerConsumptions,
} from "./store.js";
import {
  validateArtifacts,
  validateClaim,
  validateConsumptions,
  validateEvidence,
  validateExecution,
  validateJustification,
  validateRevision,
} from "./validate.js";

/**
 * `/api/knowledge` — the Knowledge Ledger's HTTP surface.
 *
 * Reads are open, like every other dashboard read; mutations are admin-gated
 * in `app.ts` alongside the pipeline routes. There is no update or delete of
 * anything: the ledger is append-only, and a claim changes by *revision*
 * (`POST /claims/:id/revise`), which is a new record, never an edit.
 *
 * The writes are the whole proposal vocabulary a future extraction agent will
 * use, so they take the same validated shapes it will produce. Phase 2 added
 * two more, under `/executions/:runId`: what a run consumed and what it
 * produced — explicit, typed provenance, never inferred from a prompt or a
 * transcript. The handlers do nothing semantic: validate → store → kernel,
 * and map the two error classes to 400 (refused) and 404 (unknown).
 */
export function knowledgeRoutes(): Hono {
  const routes = new Hono();

  async function jsonBody(c: Context) {
    try {
      return { ok: true as const, value: (await c.req.json()) as unknown };
    } catch {
      return { ok: false as const, res: c.json({ error: "invalid JSON body" }, 400) };
    }
  }

  function fail(c: Context, e: unknown) {
    if (e instanceof KnowledgeValidationError) return c.json({ error: e.message }, 400);
    if (e instanceof UnknownClaimError) return c.json({ error: e.message }, 404);
    throw e;
  }

  /**
   * Resolve a `:key` path segment to a claim, or null → 404.
   *
   * `?project=` and `?repository=` name the {@link KnowledgeScope} the key is
   * read in, so `RULE-42` means *that project's* RULE-42 and the canonical
   * `RULE-42.4f3a9c17` works too. Without them the key is read exactly as
   * written, which is how every existing caller keeps working.
   */
  function claimFor(ledger: KnowledgeLedger, raw: string, scope?: KnowledgeScope) {
    const key = parseClaimKey(raw);
    if (!key) return null;
    // A key too long to carry the scope's suffix is simply not a name that
    // scope could hold, so it is 404 like any other miss — never a 500.
    let qualified: string | null = null;
    try {
      qualified = qualifyClaimId(key.id, scope);
    } catch {
      qualified = null;
    }
    const claim = qualified ? resolveKey(ledger, { ...key, id: qualified }) : null;
    if (claim) return claim;
    // A caller naming a canonical id together with its scope: accept it, but
    // only when the two agree. A key from another scope is 404, never that
    // scope's claim.
    const exact = resolveKey(ledger, key);
    if (!exact || !scope) return scope ? null : exact;
    return sameScope(exact.scope, scope) ? exact : null;
  }

  /** `?project=` / `?repository=`, or an error response. Both or neither: a
   *  half-named scope is a different scope, not a broader one. */
  function scopeQuery(
    c: Context,
  ): { ok: true; scope?: KnowledgeScope } | { ok: false; res: Response } {
    const projectId = c.req.query("project");
    const repositoryId = c.req.query("repository");
    if (projectId === undefined && repositoryId === undefined) return { ok: true };
    if (projectId === undefined || repositoryId === undefined) {
      return {
        ok: false,
        res: c.json({ error: "project and repository must be given together" }, 400),
      };
    }
    if (!PROJECT_ID_RE.test(projectId) || !REPOSITORY_ID_RE.test(repositoryId)) {
      return { ok: false, res: c.json({ error: "project or repository is not a valid id" }, 400) };
    }
    return { ok: true, scope: { projectId, repositoryId } };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** Every revision with derived lifecycle and support. `?kind=` and
   *  `?lifecycle=active|superseded` narrow it; unknown values are 400. */
  routes.get("/claims", async (c) => {
    const kind = c.req.query("kind");
    if (kind !== undefined && !CLAIM_KINDS.includes(kind as ClaimKind)) {
      return c.json({ error: `kind must be one of ${CLAIM_KINDS.join(" | ")}` }, 400);
    }
    const lifecycle = c.req.query("lifecycle");
    if (lifecycle !== undefined && lifecycle !== "active" && lifecycle !== "superseded") {
      return c.json({ error: "lifecycle must be active | superseded" }, 400);
    }
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const ledger = await readLedger();
    // Scoped when asked, whole-ledger otherwise. This is an operator surface,
    // so "everything" stays available and is simply never what a pipeline
    // sees — no agent reads this route.
    const source = scope.scope ? claimsInScopes(ledger, [scope.scope]) : ledger.claims;
    const claims = source
      .filter((cl) => !kind || cl.kind === kind)
      .map((cl) => viewOf(ledger, cl))
      .filter((v) => !lifecycle || v.lifecycle === lifecycle);
    const body: ClaimsResponse = { claims };
    return c.json(body);
  });

  /** One claim by `ID` (active revision) or `ID:vN`, with its full history. */
  routes.get("/claims/:key", async (c) => {
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"), scope.scope);
    if (!claim) return c.json({ error: "not found" }, 404);
    const body: ClaimDetail = {
      claim: viewOf(ledger, claim),
      revisions: revisionsOf(ledger, claim.id).map((r) => viewOf(ledger, r)),
    };
    return c.json(body);
  });

  /** Why the claim is supported (or not): every signal with its force. */
  routes.get("/claims/:key/support", async (c) => {
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"), scope.scope);
    if (!claim) return c.json({ error: "not found" }, 404);
    return c.json(supportReport(ledger, refOf(claim)));
  });

  /** What depends on the claim, directly and transitively. */
  routes.get("/claims/:key/dependents", async (c) => {
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"), scope.scope);
    if (!claim) return c.json({ error: "not found" }, 404);
    return c.json(dependentsReport(ledger, refOf(claim)));
  });

  /** Which executions consumed this exact revision. */
  routes.get("/claims/:key/consumers", async (c) => {
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"), scope.scope);
    if (!claim) return c.json({ error: "not found" }, 404);
    return c.json(consumersReport(ledger, refOf(claim)));
  });

  /** What rests on this revision being current and supported — claims,
   *  justifications, consuming executions, their artifacts — and why. */
  routes.get("/claims/:key/impact", async (c) => {
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"), scope.scope);
    if (!claim) return c.json({ error: "not found" }, 404);
    const traverse = c.req.query("traverse");
    if (traverse !== undefined && traverse !== "scope" && traverse !== "ledger") {
      return c.json({ error: "traverse must be scope | ledger" }, 400);
    }
    // Bounded to the claim's own scope unless the caller asks, explicitly and
    // by name, for the whole ledger.
    return c.json(analyzeImpact(ledger, refOf(claim), { traverse: traverse ?? "scope" }));
  });

  /** Everything the ledger knows about one run: what it consumed (with
   *  currency now), what it produced. 404 when it knows nothing. */
  routes.get("/executions/:runId/provenance", async (c) => {
    const runId = c.req.param("runId");
    if (!EXECUTION_ID_RE.test(runId)) return c.json({ error: "not found" }, 404);
    const ledger = await readLedger();
    const report = executionProvenance(ledger, runId);
    if (!report) return c.json({ error: "not found" }, 404);
    return c.json(report);
  });

  // ── KnowledgeContext (Phase 4, hardened in 4.1) ──────────────────────────
  // What Argus *supplied* to a run, as distinct from what the run declared it
  // consumed. The authoritative record is the ledger's durable
  // `SuppliedContext` (exact refs + the file's sha256 + when), written before
  // the process started, so both reads survive run and invocation pruning.
  // The invocation record is the *operational* launch record and answers only
  // for where the file was; the materialized document is an operational
  // artifact and may be gone, which the response says outright rather than
  // rebuilding anything from today's ledger. The comparison with the ledger's
  // consumption edges is computed per read.

  /** Exactly which claim revisions run `:runId` received, the file's hash,
   *  the ledger's consumptions for the run, and the three-way comparison.
   *  404 only when Argus supplied the run no semantic context at all. */
  routes.get("/executions/:runId/context", async (c) => {
    const runId = c.req.param("runId");
    if (!EXECUTION_ID_RE.test(runId)) return c.json({ error: "not found" }, 404);
    const ledger = await readLedger();
    const durable = suppliedContextOf(ledger, runId);
    // The invocation record is consulted for the file path (and, for a run
    // launched before Phase 4.1, for the supplied set itself).
    const invocation = await readInvocation(runId);
    const record = durable
      ? { schemaVersion: durable.schemaVersion, claims: durable.claims, sha256: durable.sha256 }
      : (invocation?.knowledgeContext ?? null);
    if (!record) return c.json({ error: "not found" }, 404);
    const file = invocation?.knowledgeContextFile ?? null;
    const supplied = record.claims.map((r) => ({ id: r.id, revision: r.revision }));
    const consumed = ledger.consumptions
      .filter((k) => k.execution.runId === runId)
      .map((k) => ({ id: k.claim.id, revision: k.claim.revision }));
    const projection = file ? await readKnowledgeContext(file) : null;
    const body: ExecutionContextReport = {
      execution: executionOf(ledger, runId) ??
        durable?.execution ?? {
          runId,
          instanceId: invocation?.instanceId,
          phaseId: invocation?.phaseId,
        },
      context: {
        ...record,
        file,
        suppliedAt: durable?.suppliedAt ?? invocation?.startedAt ?? "",
        projectionAvailable: projection !== null,
      },
      supplied,
      consumed,
      comparison: compareSuppliedConsumed(supplied, consumed),
      projection,
    };
    return c.json(body);
  });

  /** Which runs were supplied this exact revision — from the ledger's durable
   *  supplied provenance, oldest launch first, so a run whose invocation
   *  directory has been pruned is still listed. */
  routes.get("/claims/:key/supplied-to", async (c) => {
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"), scope.scope);
    if (!claim) return c.json({ error: "not found" }, 404);
    const body: SuppliedToReport = suppliedToReport(ledger, refOf(claim));
    return c.json(body);
  });

  // ── KnowledgeDeltas (Phase 3) ────────────────────────────────────────────
  // Inspection only. The agent boundary is the per-run file, never this API:
  // a delta is staged by the engine when its run completes and committed by
  // the engine when its phase is accepted. Reads are open like every other
  // dashboard read; there is nothing to write.

  /** One staged/applied/rejected/superseded delta, with its provenance and,
   *  once applied, what it became. */
  routes.get("/deltas/:id", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const record = await readDeltaRecordById(id);
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json(record);
  });

  /**
   * The deterministic candidate preview of one delta (Phase 5): what would
   * become canonical if its phase were approved, with the ledger's current
   * state for anything it revises and every structural warning.
   *
   * Derived per read and read-only — the same projection the gate review
   * embeds, exposed on its own so a reviewer, `argus tail` or a script can
   * inspect a candidate by delta id. It carries no filesystem warnings: those
   * need the run's working tree, which the engine has at intake and commit
   * and this route deliberately does not go looking for.
   */
  routes.get("/deltas/:id/preview", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const record = await readDeltaRecordById(id);
    if (!record) return c.json({ error: "not found" }, 404);
    const body: KnowledgeDeltaPreview = previewKnowledgeDelta(record, await readLedger());
    return c.json(body);
  });

  /** The application result alone: local id → canonical identity, and every
   *  record the delta created. 404 until the delta is applied. */
  routes.get("/deltas/:id/result", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const record = await readDeltaRecordById(id);
    if (!record?.result) return c.json({ error: "not found" }, 404);
    return c.json(record.result);
  });

  // ── Rule verification (Phase 6) ──────────────────────────────────────────
  //
  // Read-only, like the delta routes and for the same reason: a verification
  // record is created by exactly one path — an accepted verification phase's
  // commit — and there is deliberately no admin mutation for it. Nothing here
  // can create, edit or retarget a conformance result.
  //
  // The distinction these routes exist to keep legible is the one the whole
  // phase is about: `GET /claims/:key/support` answers "is the rule well
  // founded?"; `GET /claims/:key/conformance` answers "does the code do what
  // it says?". They are different questions with different answers, and a
  // violated implementation never moves the first one.

  /** Every verification of this exact revision, oldest first. `RULE-42` means
   *  the active revision; `RULE-42:v1` means exactly v1, and a verification of
   *  v1 is never listed under v2. */
  routes.get("/claims/:key/verifications", async (c) => {
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"), scope.scope);
    if (!claim) return c.json({ error: "not found" }, 404);
    const body: ClaimVerificationsResponse = {
      claim: refOf(claim),
      verifications: verificationsOfClaim(ledger, refOf(claim)),
    };
    return c.json(body);
  });

  /**
   * Implementation conformance for this exact revision, optionally scoped to a
   * repository revision with `?gitHead=`.
   *
   * Without `gitHead` the answer is the latest recorded outcome and
   * `latest.repository.gitHead` says which commit it was about — a statement
   * about the past. With one, only verifications of that commit count, so a
   * rule verified `holds` at `abc123` answers `unverified` at `def456`:
   * conformance is never timeless.
   */
  routes.get("/claims/:key/conformance", async (c) => {
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"), scope.scope);
    if (!claim) return c.json({ error: "not found" }, 404);
    const gitHead = c.req.query("gitHead");
    if (gitHead !== undefined && !/^[0-9a-fA-F]{7,64}$/.test(gitHead)) {
      return c.json({ error: "gitHead must be a hex commit sha" }, 400);
    }
    const body: RuleConformanceReport = ruleConformance(ledger, refOf(claim), gitHead);
    return c.json(body);
  });

  /** Every conformance result one execution produced. */
  routes.get("/executions/:runId/verifications", async (c) => {
    const runId = c.req.param("runId");
    if (!EXECUTION_ID_RE.test(runId)) return c.json({ error: "not found" }, 404);
    const ledger = await readLedger();
    const body: ExecutionVerificationsResponse = {
      runId,
      verifications: verificationsOfRun(ledger, runId),
    };
    return c.json(body);
  });

  /** One staged/applied/rejected/superseded verification proposal, with the
   *  rules its run was accountable for and what it concluded. */
  routes.get("/verifications/:id", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const record = await readVerificationRecordById(id);
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json(record);
  });

  /** The deterministic review projection of one staged proposal: outcomes
   *  grouped, each with the rule's own support beside it. */
  routes.get("/verifications/:id/preview", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const record = await readVerificationRecordById(id);
    if (!record) return c.json({ error: "not found" }, 404);
    const body: RuleVerificationPreview = previewRuleVerification(record, await readLedger());
    return c.json(body);
  });

  /** The proposal one run staged, if any. */
  routes.get("/executions/:runId/verification-proposal", async (c) => {
    const runId = c.req.param("runId");
    if (!EXECUTION_ID_RE.test(runId)) return c.json({ error: "not found" }, 404);
    const record = await readVerificationRecord(runId);
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json(record);
  });

  /** Every delta a run emitted — at most one, by protocol — in a list so the
   *  shape holds if a later phase lets a run stage more than one. */
  routes.get("/executions/:runId/deltas", async (c) => {
    const runId = c.req.param("runId");
    if (!EXECUTION_ID_RE.test(runId)) return c.json({ error: "not found" }, 404);
    const record = await readDeltaRecord(runId);
    const body: KnowledgeDeltasResponse = { runId, deltas: record ? [record] : [] };
    return c.json(body);
  });

  // ── Change intent (Phase 7) ───────────────────────────────────────────────
  //
  // Reads only. There is deliberately no mutation here: a change proposal
  // becomes canonical exactly one way — an agent proposes it, a person
  // approves the gate, and the phase's commit writes it — and an HTTP route
  // that could record one would be a second path around the review that the
  // whole phase exists to guarantee.

  /**
   * Accepted change proposals, newest first. `?request=<id>` narrows to the
   * ones answering one request, which is how "what have we proposed about this
   * ticket?" is answered: a request may legitimately be answered more than
   * once (a revised gate, a second phase).
   */
  routes.get("/change-proposals", async (c) => {
    const ledger = await readLedger();
    const requestId = c.req.query("request");
    if (requestId !== undefined && !CLAIM_ID_RE.test(requestId)) {
      return c.json({ error: "request must be a change-request id" }, 400);
    }
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const all = requestId ? changeProposalsForRequest(ledger, requestId) : changeProposals(ledger);
    // `?project=&repository=` narrows to the changes made to one project's
    // semantics. Derived from what each proposal actually revised, never from
    // the request's wording — a ticket that mentions another product does not
    // make the change belong to it.
    const proposals = scope.scope
      ? all.filter((p) => sameScope(scopeOfAcceptedChange(ledger, p), scope.scope))
      : all;
    const body: ChangeProposalsResponse = { proposals };
    return c.json(body);
  });

  /**
   * One proposal by id: the durable accepted record when it exists, otherwise
   * the staged record beside its run.
   *
   * The two are deliberately distinguishable rather than merged — the response
   * either has `acceptedAt` or a `status` of `staged`/`rejected`/`superseded`,
   * and nothing staged ever reads as accepted.
   */
  routes.get("/change-proposals/:id", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const accepted: AcceptedChangeProposal | null = changeProposalById(await readLedger(), id);
    if (accepted) return c.json(accepted);
    const record = await readProposalRecordById(id);
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json(record);
  });

  /** The deterministic review projection of one staged proposal: the request,
   *  the current rules with their conformance, the proposed transition, what
   *  is preserved, the criteria, the unresolved questions and the warnings. */
  routes.get("/change-proposals/:id/preview", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const record = await readProposalRecordById(id);
    if (!record) return c.json({ error: "not found" }, 404);
    const deltaRecord = record.deltaId ? await readDeltaRecord(record.runId) : null;
    const body: ChangeProposalPreview = previewChangeProposal(
      record,
      await readLedger(),
      deltaRecord?.id === record.deltaId ? deltaRecord : null,
    );
    return c.json(body);
  });

  /** The proposal one run staged, if any. */
  routes.get("/executions/:runId/change-proposal", async (c) => {
    const runId = c.req.param("runId");
    if (!EXECUTION_ID_RE.test(runId)) return c.json({ error: "not found" }, 404);
    const record = await readProposalRecord(runId);
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json(record);
  });

  /**
   * Which requested change caused this **exact** claim revision to exist.
   *
   * Change provenance, not justification: this answers "who asked for it?",
   * while `GET /claims/:key/support` answers "why is it well founded?". A
   * revision nobody proposed through a change phase has no record here, which
   * is the honest answer rather than an invented one.
   */
  routes.get("/claims/:key/change-proposal", async (c) => {
    const scope = scopeQuery(c);
    if (!scope.ok) return scope.res;
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"), scope.scope);
    if (!claim) return c.json({ error: "not found" }, 404);
    const proposal = changeProposalOfClaim(ledger, refOf(claim));
    if (!proposal) return c.json({ error: "not found" }, 404);
    return c.json(proposal);
  });

  // ── Change realization (Phase 8) ─────────────────────────────────────────
  //
  // Read-only, like every other semantic surface. There is deliberately **no**
  // write API for completion state: a realization is opened, advanced and
  // closed by the pipeline engine as its phases cross their acceptance
  // boundaries, and an HTTP route that could mark one `succeeded` would be a
  // way to declare a change implemented without any of the four dimensions
  // having been established.

  /** Every realization, newest first; `?proposal=<id>` narrows to the attempts
   *  made against one accepted change — including the ones that failed, which
   *  is how the history explains how the implementation converged. */
  routes.get("/realizations", async (c) => {
    const ledger = await readLedger();
    const proposalId = c.req.query("proposal");
    if (proposalId !== undefined && !CLAIM_ID_RE.test(proposalId)) {
      return c.json({ error: "proposal must be a change-proposal id" }, 400);
    }
    const realizations: ChangeRealizationView[] = proposalId
      ? changeRealizationsForProposal(ledger, proposalId).map(realizationView)
      : changeRealizations(ledger);
    const body: ChangeRealizationsResponse = { realizations };
    return c.json(body);
  });

  /** One realization: its target, its scope, every attempt with what each one
   *  failed on, and its terminal verdict when it has one. */
  routes.get("/realizations/:id", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const realization = changeRealizationById(await readLedger(), id);
    if (!realization) return c.json({ error: "not found" }, 404);
    return c.json(realizationView(realization));
  });

  /** Which runs participated: the implementation (and remediation) executions,
   *  and the verification executions, across every attempt. */
  routes.get("/realizations/:id/runs", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const realization = changeRealizationById(await readLedger(), id);
    if (!realization) return c.json({ error: "not found" }, 404);
    const body: ChangeRealizationRunsResponse = {
      realizationId: realization.id,
      implementation: realization.attempts.flatMap((a) => a.implementation),
      verification: realization.attempts.flatMap((a) => a.verification),
    };
    return c.json(body);
  });

  /** The durable semantic records this realization's attempts produced, in
   *  commit order and unfiltered: the rule verifications and the acceptance
   *  verifications that did (or did not) prove it. */
  routes.get("/realizations/:id/results", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const ledger = await readLedger();
    const realization = changeRealizationById(ledger, id);
    if (!realization) return c.json({ error: "not found" }, 404);
    const runs = new Set(realization.attempts.flatMap((a) => a.verification.map((v) => v.runId)));
    const body: ChangeRealizationResultsResponse = {
      realizationId: realization.id,
      proposalId: realization.proposalId,
      rules: ledger.verifications.filter((v) => runs.has(v.execution.runId)),
      acceptance: ledger.acceptanceVerifications.filter((v) => runs.has(v.execution.runId)),
    };
    return c.json(body);
  });

  /**
   * Is one accepted criterion satisfied? `?gitHead=` scopes the question to a
   * commit, exactly as the rule-conformance route does — and, exactly as
   * there, a result recorded against a *dirty* tree never answers a question
   * about a bare commit, because it cannot.
   */
  routes.get("/change-proposals/:id/criteria/:criterionId", async (c) => {
    const id = c.req.param("id");
    const criterionId = c.req.param("criterionId");
    if (!CLAIM_ID_RE.test(id) || !CLAIM_ID_RE.test(criterionId)) {
      return c.json({ error: "not found" }, 404);
    }
    const ledger = await readLedger();
    if (!changeProposalById(ledger, id)) return c.json({ error: "not found" }, 404);
    const gitHead = c.req.query("gitHead");
    const body: AcceptanceConformanceReport = acceptanceConformance(
      ledger,
      id,
      criterionId,
      gitHead ? { gitHead } : undefined,
    );
    return c.json(body);
  });

  /** Every acceptance result recorded for one accepted change, in commit
   *  order. Nothing is overwritten, so a criterion answered at three
   *  repository states has three records. */
  routes.get("/change-proposals/:id/acceptance", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const ledger = await readLedger();
    if (!changeProposalById(ledger, id)) return c.json({ error: "not found" }, 404);
    return c.json({ proposalId: id, acceptance: acceptanceVerificationsOfProposal(ledger, id) });
  });

  /** The acceptance results one run produced. */
  routes.get("/executions/:runId/acceptance", async (c) => {
    const runId = c.req.param("runId");
    if (!EXECUTION_ID_RE.test(runId)) return c.json({ error: "not found" }, 404);
    const ledger = await readLedger();
    return c.json({ runId, acceptance: acceptanceVerificationsOfRun(ledger, runId) });
  });

  /** The acceptance proposal one run staged, if any. */
  routes.get("/executions/:runId/acceptance-proposal", async (c) => {
    const runId = c.req.param("runId");
    if (!EXECUTION_ID_RE.test(runId)) return c.json({ error: "not found" }, 404);
    const record = await readAcceptanceRecord(runId);
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json(record);
  });

  /** The deterministic review projection of one staged acceptance proposal. */
  routes.get("/acceptance/:id/preview", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const record = await readAcceptanceRecordById(id);
    if (!record) return c.json({ error: "not found" }, 404);
    const body: AcceptanceVerificationPreview = previewAcceptance(record);
    return c.json(body);
  });

  /** One staged acceptance record by its staging id. */
  routes.get("/acceptance/:id", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const record = await readAcceptanceRecordById(id);
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json(record);
  });

  // ── Proposals (admin) ────────────────────────────────────────────────────

  routes.post("/claims", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      const claim = await createClaim(validateClaim(body.value), new Date());
      const ledger = await readLedger();
      return c.json(viewOf(ledger, claim), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  routes.post("/claims/:id/revise", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    const key = parseClaimKey(c.req.param("id"));
    if (!key || key.revision !== undefined) {
      return c.json({ error: "revise takes a claim id, not a revision" }, 400);
    }
    try {
      const claim = await createRevision(key.id, validateRevision(body.value), new Date());
      const ledger = await readLedger();
      return c.json(viewOf(ledger, claim), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  routes.post("/evidence", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      return c.json(await createEvidence(validateEvidence(body.value), new Date()), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  routes.post("/justifications", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      return c.json(await createJustification(validateJustification(body.value), new Date()), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  // ── Execution provenance (admin) ─────────────────────────────────────────
  // 201 when at least one edge was new, 200 when every edge already existed:
  // registration is idempotent and the status says which happened.

  /** "Run R consumed these exact revisions." Bare ids resolve at write time. */
  routes.post("/executions/:runId/consumptions", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      const execution = validateExecution(c.req.param("runId"), body.value);
      const { added, ...result } = await registerConsumptions(
        execution,
        validateConsumptions(body.value),
        new Date(),
      );
      const out: ConsumptionsResponse = result;
      return c.json(out, added > 0 ? 201 : 200);
    } catch (e) {
      return fail(c, e);
    }
  });

  /** "Run R produced these artifacts." */
  routes.post("/executions/:runId/artifacts", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      const execution = validateExecution(c.req.param("runId"), body.value);
      const { added, ...result } = await registerArtifacts(
        execution,
        validateArtifacts(body.value),
        new Date(),
      );
      const out: ArtifactProductionsResponse = result;
      return c.json(out, added > 0 ? 201 : 200);
    } catch (e) {
      return fail(c, e);
    }
  });

  return routes;
}
