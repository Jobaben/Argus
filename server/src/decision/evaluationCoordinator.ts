import { randomUUID } from "node:crypto";
import type { DecisionAssessment } from "@argus/contracts";
import { KeyedMutex } from "../mutex.js";
import { canonicalDigest, canonicalJson } from "./canonical.js";
import type { JournalEntry, JournalView, SnapshotLookup } from "./journal.js";
import { ASSESSMENT_ID_RE } from "./journal.js";
import type { DispatchAdmission } from "./providers/types.js";
import type { DecisionService, ReEvaluationPreparation } from "./service.js";
import { encodeLine } from "./storage.js";
import {
  callerKey,
  closed,
  date,
  digest,
  quantity,
  text,
  validateAuthorization,
  validateOwner,
  validatePreparation,
  validatePreflight,
  validateReservation,
  type AuthorizationGrant,
  type InvocationIntent,
  type InvocationSettlement,
  type Ownership,
  type PreflightEvidence,
  type Reservation,
  InvocationLedger,
  InvocationLedgerError,
} from "./invocationLedger.js";

export interface EvaluationRequest {
  namespace: string;
  key: string;
  assessmentId: string;
  provider: string;
  sample: number;
  scope: string;
  policyDigest: string;
  allowanceUsd: number;
}
export interface AdmissionBinding extends EvaluationRequest {
  invocationId: string;
  resultId: string;
  requestDigest: string;
  preparation: ReEvaluationPreparation;
  ledgerFile: string;
}
export interface NoCallProof {
  invocationId: string;
  reservationId: string;
  fence: string;
  digest: string;
  providerCalled: "no";
}
export interface SharedEvaluationGate {
  acquire(binding: AdmissionBinding): Promise<Reservation>;
  validate(reservation: Reservation, binding: AdmissionBinding): Promise<void>;
  lookup(invocationId: string): Promise<Reservation | null>;
  orphans(ledgerFile: string): Promise<Reservation[]>;
  recoverOrphan(
    reservation: Reservation,
    evidence: { ledgerFile: string; owner: Ownership; absenceObserved: true },
  ): Promise<NoCallProof | null>;
  settle(reservation: Reservation, settlement: InvocationSettlement): Promise<void>;
  cancelProvenUncalled(reservation: Reservation, proof: NoCallProof): Promise<void>;
}
export interface EvaluationCoordinatorDeps {
  ledger: InvocationLedger;
  service: Pick<DecisionService, "prepareReEvaluation" | "reEvaluate">;
  journal: { read(): Promise<JournalView>; loadSnapshot(hash: string): Promise<SnapshotLookup> };
  authorization: { authorize(binding: AdmissionBinding): Promise<AuthorizationGrant> };
  preflight: { check(binding: AdmissionBinding): Promise<PreflightEvidence> };
  ownership: {
    require(binding: {
      ledgerFile: string;
      scope: string;
      policyDigest: string;
    }): Promise<Ownership>;
    assertCurrent?(
      binding: { ledgerFile: string; scope: string; policyDigest: string },
      expected: Ownership,
    ): void;
  };
  gate: SharedEvaluationGate;
  now?: () => Date;
}
export type EvaluationDelivery =
  | InvocationSettlement
  | { state: "in-progress"; invocationId: string; resultId: string }
  | {
      state: "refused-before-call" | "unknown-outcome" | "integrity-halt";
      reason: string;
      invocationId?: string;
    };
const admissionMutex = new KeyedMutex();
const activeCalls = new Map<string, Set<string>>();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function pin<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const child of Object.values(v)) pin(child);
    Object.freeze(v);
  }
  return v;
}
function fail(reason: string): never {
  throw new InvocationLedgerError(`integrity: ${reason}`);
}
const boundedReason = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 2000);
function validateRequest(v: unknown): void {
  closed(v, {
    namespace: text,
    key: text,
    assessmentId: (id) => {
      if (typeof id !== "string" || !ASSESSMENT_ID_RE.test(id)) fail("assessment id");
    },
    provider: text,
    sample: (n) => {
      if (!Number.isSafeInteger(n) || Number(n) < 0) fail("sample");
    },
    scope: text,
    policyDigest: digest,
    allowanceUsd: quantity,
  });
}
function strictJournal(view: JournalView): void {
  if (
    view.notices.length ||
    view.gaps.length ||
    view.segments.some((s) => s.integrity !== "intact" && s.integrity !== "open")
  )
    fail("journal integrity unavailable");
  const ids = new Set<string>();
  for (const entry of view.entries) {
    if (
      ids.has(entry.assessment.id) ||
      encodeLine("assessment", entry.assessment).digest !== entry.digest
    )
      fail("journal digest or duplicate");
    ids.add(entry.assessment.id);
  }
}
export function createEvaluationCoordinator(deps: EvaluationCoordinatorDeps) {
  const file = deps.ledger.file;
  const now = () => {
    const at = (deps.now ?? (() => new Date()))().toISOString();
    date(at);
    return at;
  };
  const live = () => (activeCalls.get(file)?.size ? activeCalls.get(file)! : new Set<string>());
  const mark = (id: string) => {
    const set = activeCalls.get(file) ?? new Set<string>();
    set.add(id);
    activeCalls.set(file, set);
  };
  const unmark = (id: string) => {
    const set = activeCalls.get(file);
    set?.delete(id);
    if (!set?.size) activeCalls.delete(file);
  };
  async function owner(bound: { scope: string; policyDigest: string }): Promise<Ownership> {
    const o = pin(
      JSON.parse(
        canonicalJson(
          await deps.ownership.require({
            ledgerFile: file,
            scope: bound.scope,
            policyDigest: bound.policyDigest,
          }),
        ),
      ) as Ownership,
    );
    validateOwner(o);
    if (o.ledgerFile !== file || o.scope !== bound.scope || o.policyDigest !== bound.policyDigest)
      fail("ownership binding");
    if (Date.parse(o.expiresAt) <= Date.parse(now())) throw Error("expired ownership");
    return o;
  }
  const binding = (i: InvocationIntent): AdmissionBinding => ({
    namespace: i.namespace,
    key: i.key,
    assessmentId: i.preparation.assessmentId,
    provider: i.preparation.providerKey,
    sample: i.preparation.sample,
    scope: i.reservation.scope,
    policyDigest: i.reservation.policyDigest,
    allowanceUsd: i.reservation.allowanceUsd,
    invocationId: i.invocationId,
    resultId: i.resultId,
    requestDigest: i.requestDigest,
    preparation: i.preparation,
    ledgerFile: file,
  });
  function checkReservation(r: Reservation, b: AdmissionBinding): void {
    validateReservation(r);
    if (
      r.invocationId !== b.invocationId ||
      r.requestDigest !== b.requestDigest ||
      r.scope !== b.scope ||
      r.policyDigest !== b.policyDigest ||
      r.allowanceUsd !== b.allowanceUsd
    )
      fail("reservation binding");
  }
  async function flushGate(i: InvocationIntent, s: InvocationSettlement): Promise<void> {
    await owner(i.reservation);
    const r = await deps.gate.lookup(i.invocationId);
    if (!r || !same(r, i.reservation)) fail("missing or changed durable reservation");
    await deps.gate.settle(r, s);
  }
  async function publish(
    i: InvocationIntent,
    intentDigest: string,
    s: Omit<InvocationSettlement, "invocationId" | "intentDigest" | "resultId" | "at">,
  ): Promise<InvocationSettlement> {
    await owner(i.reservation);
    const settlement: InvocationSettlement = {
      ...s,
      invocationId: i.invocationId,
      intentDigest,
      resultId: i.resultId,
      at: now(),
    };
    await deps.ledger.appendSettlement(settlement);
    await flushGate(i, settlement);
    return settlement;
  }
  async function recoverOrphans(): Promise<void> {
    const state = await deps.ledger.load();
    for (const r of await deps.gate.orphans(file)) {
      validateReservation(r);
      if (state.intents.has(r.invocationId)) continue;
      const o = await owner(r);
      const proof = await deps.gate.recoverOrphan(r, {
        ledgerFile: file,
        owner: o,
        absenceObserved: true,
      });
      if (proof === null)
        fail("unresolved orphan reservation; admission halted without no-call proof");
      closed(proof, {
        invocationId: text,
        reservationId: text,
        fence: text,
        digest,
        providerCalled: (v) => {
          if (v !== "no") fail("no-call proof");
        },
      });
      if (
        proof.invocationId !== r.invocationId ||
        proof.reservationId !== r.id ||
        proof.fence !== o.fence
      )
        fail("orphan proof binding");
      const current = await owner(r);
      if (current.identity !== o.identity || current.fence !== o.fence)
        fail("stale orphan proof fence");
      await deps.gate.cancelProvenUncalled(r, proof);
    }
  }
  async function exactResult(i: InvocationIntent, view: JournalView): Promise<JournalEntry | null> {
    strictJournal(view);
    const p = i.preparation,
      parent = view.entries.find((e) => e.assessment.id === p.assessmentId),
      result = view.entries.find((e) => e.assessment.id === i.resultId);
    if (
      parent &&
      (!same({ digest: parent.digest, segment: parent.segment, line: parent.line }, p.parent) ||
        !same(parent.assessment.question, p.question) ||
        !same(parent.assessment.subject, p.snapshot.subject) ||
        !same(parent.assessment.snapshot, {
          sha256: p.snapshot.sha256,
          bytes: p.snapshot.bytes,
          projection: p.projection,
        }))
    )
      fail("parent provenance conflict");
    if (!result) return null;
    if (!parent) fail("result parent provenance missing");
    const a = result.assessment;
    if (
      a.mode !== "shadow" ||
      a.reEvaluates !== p.assessmentId ||
      a.sample !== p.sample ||
      !same(a.question, p.question) ||
      !same(a.subject, p.snapshot.subject) ||
      !same(a.snapshot, {
        sha256: p.snapshot.sha256,
        bytes: p.snapshot.bytes,
        projection: p.projection,
      }) ||
      !same(
        {
          provider: a.provider.provider,
          requestedModel: a.provider.requestedModel,
          adapterVersion: a.provider.adapterVersion,
          elicitation: a.provider.elicitation,
        },
        p.provider,
      )
    )
      fail("result identity conflict");
    if (
      i.authorization.reportedModels !== null &&
      (a.provider.reportedModel === null ||
        !i.authorization.reportedModels.includes(a.provider.reportedModel))
    )
      fail("reported model outside authorization");
    const lookup = await deps.journal.loadSnapshot(p.snapshot.sha256);
    if (lookup.status === "corrupt") fail("retained snapshot corrupt");
    if (lookup.status !== "retained") return null;
    const snap = lookup.snapshot,
      sealed = canonicalDigest(snap.content);
    if (
      sealed.sha256 !== p.snapshot.sha256 ||
      sealed.bytes !== p.snapshot.bytes ||
      snap.sha256 !== p.snapshot.sha256 ||
      snap.bytes !== p.snapshot.bytes ||
      !same(snap.content.subject, p.snapshot.subject) ||
      !same(snap.content.projection, p.projection)
    )
      fail("retained snapshot conflict");
    return result;
  }
  function recorded(
    entry: JournalEntry,
  ): Omit<InvocationSettlement, "invocationId" | "intentDigest" | "resultId" | "at"> {
    const a: DecisionAssessment = entry.assessment;
    const failure = a.outcome.status === "failed" ? a.outcome.failure : null;
    const noResponse = failure === "provider-error",
      mismatch = failure === "identity-mismatch";
    return {
      state: mismatch ? "integrity-halt" : "recorded",
      resultDigest: entry.digest,
      actualProvider: noResponse || mismatch ? null : a.provider,
      outcome: a.outcome.status,
      providerCalled: "yes",
      costUsd:
        !noResponse &&
        typeof a.costUsd === "number" &&
        Number.isFinite(a.costUsd) &&
        a.costUsd >= 0 &&
        !Object.is(a.costUsd, -0)
          ? a.costUsd
          : null,
      reason: mismatch
        ? "provider identity mismatch; observed response identity unavailable"
        : noResponse
          ? "provider-error; no observed response identity"
          : "exact journal result",
    };
  }
  async function recover(i: InvocationIntent, intentDigest: string): Promise<EvaluationDelivery> {
    if (live().has(i.invocationId))
      return { state: "in-progress", invocationId: i.invocationId, resultId: i.resultId };
    const entry = await exactResult(i, await deps.journal.read());
    return publish(
      i,
      intentDigest,
      entry
        ? recorded(entry)
        : {
            state: "unknown-outcome",
            resultDigest: null,
            actualProvider: null,
            outcome: null,
            providerCalled: "unknown",
            costUsd: null,
            reason: "no exact retained result; never resend",
          },
    );
  }
  async function finalDispatchCheck(i: InvocationIntent): Promise<void> {
    const current = await owner(i.reservation);
    if (current.identity !== i.owner.identity || current.fence !== i.owner.fence)
      throw Error("ownership fence changed before dispatch");
    if ([i.authorization, i.preflight].some((e) => Date.parse(e.expiresAt) <= Date.parse(now())))
      throw Error("admission evidence expired before dispatch");
    const r = await deps.gate.lookup(i.invocationId);
    if (!r || !same(r, i.reservation)) throw Error("reservation changed before dispatch");
    await deps.gate.validate(
      pin(JSON.parse(canonicalJson(r)) as Reservation),
      pin(JSON.parse(canonicalJson(binding(i))) as AdmissionBinding),
    );
    const finalOwner = await owner(i.reservation);
    if (finalOwner.identity !== i.owner.identity || finalOwner.fence !== i.owner.fence)
      throw Error("ownership fence changed during validation");
    if ([i.authorization, i.preflight].some((e) => Date.parse(e.expiresAt) <= Date.parse(now())))
      throw Error("evidence expired during validation");
  }
  async function execute(input: EvaluationRequest): Promise<EvaluationDelivery> {
    let admitted: { intent: InvocationIntent; digest: string } | undefined;
    try {
      validateRequest(input);
      const request = pin(JSON.parse(canonicalJson(input)) as EvaluationRequest);
      const admission = await admissionMutex.withLock(file, async () => {
        await owner(request);
        strictJournal(await deps.journal.read());
        const state = await deps.ledger.load();
        const knownId = state.callers.get(callerKey(request.namespace, request.key));
        if (knownId) {
          const saved = state.intents.get(knownId)!;
          if (
            saved.intent.requestDigest !==
            canonicalDigest({ request, preparationDigest: saved.intent.preparation.digest }).sha256
          )
            return {
              delivery: {
                state: "refused-before-call" as const,
                reason: "idempotency key payload changed",
              },
            };
          const s = state.settlements.get(knownId);
          if (s) {
            await flushGate(saved.intent, s);
            return { delivery: s };
          }
          return { delivery: await recover(saved.intent, saved.digest) };
        }
        await recoverOrphans();
        const prepared = await deps.service.prepareReEvaluation({
          assessmentId: request.assessmentId,
          provider: request.provider,
          sample: request.sample,
        });
        if (!prepared.ok)
          return { delivery: { state: "refused-before-call" as const, reason: prepared.reason } };
        validatePreparation(prepared.preparation);
        const preparation = pin(
          JSON.parse(canonicalJson(prepared.preparation)) as ReEvaluationPreparation,
        );
        const requestDigest = canonicalDigest({
          request,
          preparationDigest: preparation.digest,
        }).sha256;
        const b: AdmissionBinding = pin({
          ...request,
          requestDigest,
          invocationId: `IV-${randomUUID()}`,
          resultId: `DA-${randomUUID()}`,
          preparation,
          ledgerFile: file,
        });
        const authorization = pin(
            JSON.parse(canonicalJson(await deps.authorization.authorize(b))) as AuthorizationGrant,
          ),
          preflight = pin(
            JSON.parse(canonicalJson(await deps.preflight.check(b))) as PreflightEvidence,
          ),
          o = await owner(b);
        validateAuthorization(authorization);
        validatePreflight(preflight);
        const dummy: Reservation = {
          id: "pending",
          invocationId: b.invocationId,
          requestDigest,
          scope: b.scope,
          policyDigest: b.policyDigest,
          allowanceUsd: b.allowanceUsd,
        };
        const i: InvocationIntent = {
          format: "argus.evaluation-intent",
          formatVersion: 1,
          invocationId: b.invocationId,
          namespace: b.namespace,
          key: b.key,
          requestDigest,
          resultId: b.resultId,
          preparation: b.preparation,
          authorization,
          preflight,
          owner: o,
          reservation: dummy,
          createdAt: now(),
        };
        // Reserve the maximum bounded reservation-id size before monetary admission.
        await deps.ledger.reserveCapacity({ ...i, reservation: { ...dummy, id: "x".repeat(256) } });
        const prior = await deps.gate.lookup(b.invocationId);
        if (prior) fail("unexpected pre-existing reservation");
        const r = pin(JSON.parse(canonicalJson(await deps.gate.acquire(b))) as Reservation);
        checkReservation(r, b);
        i.reservation = r;
        try {
          admitted = await deps.ledger.appendIntent(i);
        } catch (e) {
          return {
            delivery: {
              state: "unknown-outcome" as const,
              invocationId: b.invocationId,
              reason: `intent publication uncertain; no dispatch; reservation retained: ${boundedReason(e)}`,
            },
          };
        }
        mark(i.invocationId);
        return { admitted };
      });
      if ("delivery" in admission && admission.delivery) return admission.delivery;
      admitted = admission.admitted;
      if (!admitted) fail("admission missing");
      const { intent: i, digest: intentDigest } = admitted;
      let result;
      try {
        result = await deps.service.reEvaluate({
          assessmentId: i.preparation.assessmentId,
          provider: i.preparation.providerKey,
          sample: i.preparation.sample,
          id: i.resultId,
          expectedPreparationDigest: i.preparation.digest,
          beforeProviderCall: (async () => {
            try {
              if (typeof deps.ownership.assertCurrent !== "function")
                throw Error("current ownership assertion unavailable");
              await finalDispatchCheck(i);
              return {
                ok: true as const,
                validateNow: () => {
                  try {
                    const asserted: unknown = deps.ownership.assertCurrent!(
                      {
                        ledgerFile: file,
                        scope: i.reservation.scope,
                        policyDigest: i.reservation.policyDigest,
                      },
                      i.owner,
                    );
                    if (
                      asserted &&
                      (typeof asserted === "object" || typeof asserted === "function") &&
                      typeof (asserted as { then?: unknown }).then === "function"
                    ) {
                      void Promise.resolve(asserted).catch(() => {});
                      throw Error("current ownership assertion must be synchronous");
                    }
                    const at = Date.parse(now());
                    if (
                      [i.owner, i.authorization, i.preflight].some(
                        (e) => Date.parse(e.expiresAt) <= at,
                      )
                    )
                      throw Error("pinned admission evidence expired at dispatch");
                    return { ok: true as const };
                  } catch (e) {
                    return { ok: false as const, detail: boundedReason(e) };
                  }
                },
              };
            } catch (e) {
              return { ok: false as const, detail: boundedReason(e) };
            }
          }) satisfies DispatchAdmission,
        });
      } catch (e) {
        return await publish(i, intentDigest, {
          state: "unknown-outcome",
          resultDigest: null,
          actualProvider: null,
          outcome: null,
          providerCalled: "unknown",
          costUsd: null,
          reason: boundedReason(e),
        });
      }
      if (!result.ok && !result.providerCalled)
        return await publish(i, intentDigest, {
          state: "refused-before-call",
          resultDigest: null,
          actualProvider: null,
          outcome: null,
          providerCalled: "no",
          costUsd: 0,
          reason: result.reason,
        });
      const exact = await exactResult(i, await deps.journal.read());
      return await publish(
        i,
        intentDigest,
        exact
          ? recorded(exact)
          : {
              state: "unknown-outcome",
              resultDigest: null,
              actualProvider: null,
              outcome: null,
              providerCalled: "unknown",
              costUsd: null,
              reason: "no exact durable result after dispatch",
            },
      );
    } catch (e) {
      return {
        state:
          e instanceof InvocationLedgerError
            ? "integrity-halt"
            : admitted
              ? "unknown-outcome"
              : "refused-before-call",
        ...(admitted ? { invocationId: admitted.intent.invocationId } : {}),
        reason: boundedReason(e),
      };
    } finally {
      if (admitted) unmark(admitted.intent.invocationId);
    }
  }
  async function reconcile(): Promise<EvaluationDelivery[]> {
    try {
      return await admissionMutex.withLock(file, async () => {
        strictJournal(await deps.journal.read());
        await recoverOrphans();
        const state = await deps.ledger.load(),
          out: EvaluationDelivery[] = [];
        for (const [id, saved] of state.intents) {
          const s = state.settlements.get(id);
          await owner(saved.intent.reservation);
          if (s) {
            await flushGate(saved.intent, s);
            out.push(s);
          } else out.push(await recover(saved.intent, saved.digest));
        }
        return out;
      });
    } catch (e) {
      return [{ state: "integrity-halt", reason: boundedReason(e) }];
    }
  }
  return { execute, reconcile };
}
