import { Hono, type Context } from "hono";
import type { ClaimDetail, ClaimKind, ClaimsResponse } from "@argus/contracts";
import {
  CLAIM_KINDS,
  KnowledgeValidationError,
  UnknownClaimError,
  dependentsReport,
  parseClaimKey,
  refOf,
  resolveKey,
  revisionsOf,
  supportReport,
  viewOf,
  type KnowledgeLedger,
} from "./kernel.js";
import {
  createClaim,
  createEvidence,
  createJustification,
  createRevision,
  readLedger,
} from "./store.js";
import {
  validateClaim,
  validateEvidence,
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
 * The four writes are the whole proposal vocabulary a future extraction agent
 * will use, so they take the same validated shapes it will produce. The
 * handlers do nothing semantic: validate → store → kernel, and map the two
 * error classes to 400 (refused) and 404 (unknown).
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

  return routes;
}
