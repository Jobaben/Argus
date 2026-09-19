import { Hono, type Context } from "hono";
import type {
  ArtifactProductionsResponse,
  ClaimDetail,
  ClaimKind,
  ClaimsResponse,
  ConsumptionsResponse,
  ExecutionContextReport,
  KnowledgeDeltasResponse,
  SuppliedToReport,
} from "@argus/contracts";
import { readInvocation, readInvocationRunIds } from "../sources/runs.js";
import { compareSuppliedConsumed, readKnowledgeContext } from "./context.js";
import {
  CLAIM_ID_RE,
  CLAIM_KINDS,
  EXECUTION_ID_RE,
  KnowledgeValidationError,
  UnknownClaimError,
  consumersReport,
  dependentsReport,
  executionOf,
  executionProvenance,
  parseClaimKey,
  sameRef,
  refOf,
  resolveKey,
  revisionsOf,
  supportReport,
  viewOf,
  type KnowledgeLedger,
} from "./kernel.js";
import { analyzeImpact } from "./impact.js";
import { readDeltaRecord, readDeltaRecordById } from "./staging.js";
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

  /** Resolve a `:key` path segment to a claim, or null → 404. */
  function claimFor(ledger: KnowledgeLedger, raw: string) {
    const key = parseClaimKey(raw);
    return key ? resolveKey(ledger, key) : null;
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
    const ledger = await readLedger();
    const claims = ledger.claims
      .filter((cl) => !kind || cl.kind === kind)
      .map((cl) => viewOf(ledger, cl))
      .filter((v) => !lifecycle || v.lifecycle === lifecycle);
    const body: ClaimsResponse = { claims };
    return c.json(body);
  });

  /** One claim by `ID` (active revision) or `ID:vN`, with its full history. */
  routes.get("/claims/:key", async (c) => {
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"));
    if (!claim) return c.json({ error: "not found" }, 404);
    const body: ClaimDetail = {
      claim: viewOf(ledger, claim),
      revisions: revisionsOf(ledger, claim.id).map((r) => viewOf(ledger, r)),
    };
    return c.json(body);
  });

  /** Why the claim is supported (or not): every signal with its force. */
  routes.get("/claims/:key/support", async (c) => {
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"));
    if (!claim) return c.json({ error: "not found" }, 404);
    return c.json(supportReport(ledger, refOf(claim)));
  });

  /** What depends on the claim, directly and transitively. */
  routes.get("/claims/:key/dependents", async (c) => {
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"));
    if (!claim) return c.json({ error: "not found" }, 404);
    return c.json(dependentsReport(ledger, refOf(claim)));
  });

  /** Which executions consumed this exact revision. */
  routes.get("/claims/:key/consumers", async (c) => {
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"));
    if (!claim) return c.json({ error: "not found" }, 404);
    return c.json(consumersReport(ledger, refOf(claim)));
  });

  /** What rests on this revision being current and supported — claims,
   *  justifications, consuming executions, their artifacts — and why. */
  routes.get("/claims/:key/impact", async (c) => {
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"));
    if (!claim) return c.json({ error: "not found" }, 404);
    return c.json(analyzeImpact(ledger, refOf(claim)));
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

  // ── KnowledgeContext (Phase 4) ───────────────────────────────────────────
  // What Argus *supplied* to a run, as distinct from what the run declared it
  // consumed. The authoritative record is the run's invocation record (exact
  // refs + the file's sha256), written before the process started; both
  // reads derive from it rather than from a second store. The comparison
  // with the ledger's consumption edges is computed per read.

  /** Exactly which claim revisions run `:runId` received, the file's hash,
   *  the ledger's consumptions for the run, and the three-way comparison.
   *  404 when the run has no invocation record or was launched without a
   *  semantic context. */
  routes.get("/executions/:runId/context", async (c) => {
    const runId = c.req.param("runId");
    if (!EXECUTION_ID_RE.test(runId)) return c.json({ error: "not found" }, 404);
    const invocation = await readInvocation(runId);
    if (!invocation?.knowledgeContext || !invocation.knowledgeContextFile) {
      return c.json({ error: "not found" }, 404);
    }
    const ledger = await readLedger();
    const supplied = invocation.knowledgeContext.claims.map((r) => ({
      id: r.id,
      revision: r.revision,
    }));
    const consumed = ledger.consumptions
      .filter((k) => k.execution.runId === runId)
      .map((k) => ({ id: k.claim.id, revision: k.claim.revision }));
    const body: ExecutionContextReport = {
      execution: executionOf(ledger, runId) ?? {
        runId,
        instanceId: invocation.instanceId,
        phaseId: invocation.phaseId,
      },
      context: { ...invocation.knowledgeContext, file: invocation.knowledgeContextFile },
      supplied,
      consumed,
      comparison: compareSuppliedConsumed(supplied, consumed),
      projection: await readKnowledgeContext(invocation.knowledgeContextFile),
    };
    return c.json(body);
  });

  /** Which runs were supplied this exact revision — derived from the
   *  invocation records still on disk, oldest launch first. */
  routes.get("/claims/:key/supplied-to", async (c) => {
    const ledger = await readLedger();
    const claim = claimFor(ledger, c.req.param("key"));
    if (!claim) return c.json({ error: "not found" }, 404);
    const ref = refOf(claim);
    const records = await Promise.all((await readInvocationRunIds()).map(readInvocation));
    const executions = records
      .flatMap((inv) =>
        inv?.knowledgeContext?.claims.some((r) => sameRef(r, ref))
          ? [
              {
                execution: { runId: inv.runId, instanceId: inv.instanceId, phaseId: inv.phaseId },
                suppliedAt: inv.startedAt,
                sha256: inv.knowledgeContext.sha256,
              },
            ]
          : [],
      )
      .sort(
        (a, b) =>
          a.suppliedAt.localeCompare(b.suppliedAt) ||
          a.execution.runId.localeCompare(b.execution.runId),
      );
    const body: SuppliedToReport = { claim: ref, executions };
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

  /** The application result alone: local id → canonical identity, and every
   *  record the delta created. 404 until the delta is applied. */
  routes.get("/deltas/:id/result", async (c) => {
    const id = c.req.param("id");
    if (!CLAIM_ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const record = await readDeltaRecordById(id);
    if (!record?.result) return c.json({ error: "not found" }, 404);
    return c.json(record.result);
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
