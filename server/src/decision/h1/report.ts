import type {
  DecisionAssessment,
  DefinitionRef,
  H1BaselineRow,
  H1Census,
  H1ConfigSummary,
  H1ModelPopulation,
  H1Population,
  H1ReferenceLabel,
  H1Report,
  H1VerdictRow,
  H2AttemptClass,
  H2Finding,
  ProviderIdentity,
} from "@argus/contracts";
import { checkOutcome } from "../answers.js";
import { canonicalJson } from "../canonical.js";
import { distribution, MIN_BUCKET, MIN_ECE_N, round6, totals } from "../h2/metrics.js";
import type { DecisionJournal, JournalNoticeKind, JournalView } from "../journal.js";
import type { DecisionRegistry } from "../registry.js";
import { applyGateRules, GATE_RULES_V1_REF, QUALIFICATION_V1_REF } from "./baselines.js";
import { H1_DEFAULTS } from "./config.js";
import { H1_QUESTION } from "./definitions.js";
import { referenceDigest } from "./gate.js";
import {
  BENIGN_H1_NOTICES,
  type H1AttemptRecord,
  type H1CaptureRecord,
  type H1Config,
  type H1Ledger,
  type H1LedgerView,
  type H1PostCheckRecord,
  type H1ResultRecord,
  type H1SettleRecord,
} from "./ledger.js";
import {
  agreementOf,
  aurocLowerMeansPositive,
  binaryBrier,
  binaryEce,
  binaryPrediction,
  binaryReliability,
  MODEL_SPEC,
  RULES_SPEC,
  VERDICT_SPEC,
  type BinaryCalibrated,
} from "./metrics.js";
import type { GateReviewBody } from "./projection.js";
import type { H1SnapshotStore, StoredLookup } from "./snapshots.js";

/**
 * The H1 report, `decision-h1-report` v1 (RFC §Q.11): a deterministic replay
 * of the H1 ledger, the H1 snapshot store and the Decision Journal.
 *
 * It is a reader: no provider, no runner, no live instance, run, verdict or
 * gate record, and no wall clock ("pending" is as of the last ledger line).
 *
 * **Blinding (§Q.10).** Only settled items whose attempt stopped being
 * eligible contribute to any cell. An unsettled item — including one whose
 * call has happened — appears only in the pending counts. Its journal
 * assessment is never read into the report.
 */

export const H1_REPORT_V1 = { id: "decision-h1-report", version: 1 } as const;

export const H1_STATEMENT =
  "Agreement here is agreement with what the operator did at the gate: behaviour, not correctness. An approved attempt may still be wrong and a revised one may have been fine. No figure in this report can justify skipping review.";

const ATTEMPT_CLASSES: readonly H2AttemptClass[] = [
  "answered",
  "abstained",
  "provider-failed",
  "refused",
  "missing-input",
  "construction-error",
  "unrecorded",
  "unknown-outcome",
  "unresolved",
];
const ASSESSED: ReadonlySet<H2AttemptClass> = new Set(["answered", "abstained", "provider-failed"]);
const JOURNAL_BENIGN: ReadonlySet<JournalNoticeKind> = new Set([
  "torn-tail",
  "recovered-torn-write",
  "duplicate",
]);
const INFORMATIONAL = new Set(["requested-model-differs", "reconciled-in-report"]);
const POPULATIONS: readonly H1Population[] = ["manual", "auto-approve-declared"];

export const H1_METHODS: Record<string, string> = {
  target:
    "gate.operator-action@1: will the operator send this phase attempt back (revise or abort) rather than approve it as it stands? p is the probability of sent back",
  populations:
    "manual gates and gates whose definition declares autoApprove are separate populations; model rows are further split by question id, version and digest, projection digest and full provider identity; nothing is pooled",
  scoring:
    "an item is scored when it is settled with an applied operator decision on the exact attempt, its review state held (no drift, and the action bracketed by observations at most 10 minutes apart), and, for a model row, its assessment is present and a post-check after the result saw the attempt still eligible and unchanged",
  threshold:
    "a model predicts sent back when p > 0.5 and approve when p < 0.5; p = 0.5 is a tie, answered but never agreement, never a false close and never a false escalation",
  agreement:
    "agreement with operator behaviour, not correctness: answered-only = agreeing / answered, with coverage = answered / scored; end-to-end = agreeing / scored, where abstentions, failures and coverage gaps count as not agreeing",
  falseClose:
    "predicts approve / operator sent back, over answered items (ties in the denominator)",
  falseEscalation:
    "predicts sent back / operator approved, over answered items (ties in the denominator)",
  intervals: "Wilson score interval, 95 % (z = 1.959964); null when n = 0",
  brier:
    "model rows only: mean (p − y)² over answered scored items with a validated probability, y = 1 for sent back; range 0–1",
  reliability: `model rows only: 10 equal-width bins of p, bin = min(9, floor(10·p)), mean p against the observed sent-back rate, shown only at n ≥ ${MIN_BUCKET}`,
  ece: `model rows only: n-weighted mean |observed rate − mean p| over non-empty bins, only at N ≥ ${MIN_ECE_N}`,
  kappa: "Cohen's κ over answered items, with tie as a prediction category",
  deterministic:
    "gate-operator-action.rules@1, a rule result (flag / no-flag / insufficient-data) computed at capture from the captured body and recomputed here; never a probability",
  verdict:
    "auto-approval-qualification@1 at capture: qualifies is compared as approve and below-threshold as sent back; not-configured, ineligible and insufficient-data are coverage gaps. The rating (minimum current score over relevant steps) is ordinal: no Brier, calibration or score/10",
  auroc:
    "Verdict rows: Mann–Whitney AUROC with sent back positive and a lower rating expected to mean sent back, ties ½, Hanley–McNeil 95 % interval",
  references:
    "applied operator gate decisions on the exact attempt, retained with the record's digest at settlement; automated, unattributed, incomplete, unapplied, conflicting and unknown records are never references, and unlabeled items are never negatives. A session principal is an account, not proof of a person",
  blinding:
    "only settled items whose attempt left the gate contribute to any cell; unsettled items, including those already called, appear only as pending counts",
  percentiles: "nearest-rank",
};

// ── Indexing ────────────────────────────────────────────────────────────────

interface AttemptEntry {
  attempt: H1AttemptRecord;
  line: number;
  result: H1ResultRecord | null;
  postCheck: H1PostCheckRecord | null;
}

interface ItemEntry {
  capture: H1CaptureRecord;
  line: number;
  drift: boolean;
  prechecks: string[];
  attempts: AttemptEntry[];
  settle: H1SettleRecord | null;
}

function index(view: H1LedgerView) {
  const configs: Array<{ digest: string; at: string; config: H1Config }> = [];
  const items = new Map<string, ItemEntry>();
  const gates = new Map<string, string>();
  const attempts: AttemptEntry[] = [];
  const byAttempt = new Map<string, AttemptEntry>();
  let start: string | null = null;
  for (const { line, record: r } of view.records) {
    switch (r.kind) {
      case "start":
        start ??= r.at;
        break;
      case "config":
        configs.push({ digest: r.digest, at: r.at, config: r.config });
        break;
      case "gate":
        if (!gates.has(r.itemKey)) gates.set(r.itemKey, r.reason);
        break;
      case "capture":
        if (!items.has(r.itemKey)) {
          items.set(r.itemKey, {
            capture: r,
            line,
            drift: false,
            prechecks: [],
            attempts: [],
            settle: null,
          });
        }
        break;
      case "drift": {
        const it = items.get(r.itemKey);
        if (it) it.drift = true;
        break;
      }
      case "precheck":
        items.get(r.itemKey)?.prechecks.push(r.reason);
        break;
      case "attempt": {
        const e = { attempt: r, line, result: null, postCheck: null };
        attempts.push(e);
        byAttempt.set(r.attemptId, e);
        items.get(r.itemKey)?.attempts.push(e);
        break;
      }
      case "result": {
        const e = byAttempt.get(r.attemptId);
        if (e && !e.result) e.result = r;
        break;
      }
      case "post-check": {
        const e = byAttempt.get(r.attemptId);
        if (e && !e.postCheck) e.postCheck = r;
        break;
      }
      case "settle": {
        const it = items.get(r.itemKey);
        if (it && !it.settle) it.settle = r;
        break;
      }
    }
  }
  return { start, configs, items, gates, attempts };
}

const refEq = (a: DefinitionRef, b: DefinitionRef) =>
  a.id === b.id && a.version === b.version && a.digest === b.digest;

function classOf(a: DecisionAssessment): { cls: H2AttemptClass; code: string | null } {
  const o = a.outcome;
  if (o.status === "answered" || o.status === "abstained") return { cls: o.status, code: null };
  return { cls: "provider-failed", code: o.failure };
}

// ── The report ──────────────────────────────────────────────────────────────

export interface H1ReplayInputs {
  ledger: H1LedgerView;
  snapshots: ReadonlyMap<string, StoredLookup>;
  journal: JournalView;
  registry: DecisionRegistry;
}

type ItemState = "held" | "changed" | "unobserved";

export function buildH1Report({ ledger, snapshots, journal, registry }: H1ReplayInputs): H1Report {
  const idx = index(ledger);
  const findings: H2Finding[] = [];
  const finding = (kind: string, line: number | null, attemptId: string | null, detail: string) =>
    findings.push({ kind, line, attemptId, detail });
  const configByDigest = new Map(idx.configs.map((c) => [c.digest, c.config]));
  const byId = new Map<string, DecisionAssessment>();
  for (const e of journal.entries)
    if (!byId.has(e.assessment.id)) byId.set(e.assessment.id, e.assessment);

  // Snapshot integrity and baseline recomputation, for every capture: neither
  // reveals a prediction.
  for (const it of idx.items.values()) {
    const c = it.capture;
    const s = snapshots.get(c.snapshot.sha256);
    if (!s || s.status === "missing") {
      finding(
        "snapshot-missing",
        it.line,
        null,
        `snapshot ${c.snapshot.sha256} of ${c.itemKey} is not in the store`,
      );
      continue;
    }
    if (s.status === "corrupt") {
      finding("snapshot-corrupt", it.line, null, `snapshot ${c.snapshot.sha256}: ${s.detail}`);
      continue;
    }
    const subj = s.snapshot.content.subject;
    if (
      subj.kind !== "phase-attempt" ||
      subj.instanceId !== c.instanceId ||
      subj.phaseId !== c.phaseId ||
      subj.attempt !== c.attempt
    ) {
      finding(
        "snapshot-subject-mismatch",
        it.line,
        null,
        `snapshot ${c.snapshot.sha256} is about another attempt`,
      );
    }
  }

  // Scoring state per item.
  const maxBracket = (it: ItemEntry) =>
    configByDigest.get(it.capture.config)?.observation.maxBracketMs ??
    H1_DEFAULTS.observation.maxBracketMs;
  const resolved = (it: ItemEntry) => !!it.settle && it.settle.outcome !== "window-closed";
  const stateOf = (it: ItemEntry): ItemState => {
    if (it.drift) return "changed";
    const b = it.settle!.bracket;
    if (!b.lastEligibleAt) return "unobserved";
    const width = Date.parse(b.firstIneligibleAt) - Date.parse(b.lastEligibleAt);
    return !Number.isFinite(width) || width < 0 || width > maxBracket(it) ? "unobserved" : "held";
  };
  /** The operator-action label, when the item has a valid retained reference. */
  const labelOf = (it: ItemEntry): H1ReferenceLabel | null => {
    const s = it.settle;
    if (!s || s.outcome !== "labeled" || !s.reference) return null;
    const { digest, ...rest } = s.reference;
    if (referenceDigest(rest) !== digest) return null;
    return s.reference.label;
  };
  for (const it of idx.items.values()) {
    const s = it.settle;
    if (s?.outcome === "labeled" && s.reference) {
      const { digest, ...rest } = s.reference;
      if (referenceDigest(rest) !== digest) {
        finding(
          "reference-corrupt",
          it.line,
          null,
          `the retained reference of ${it.capture.itemKey} does not match its digest`,
        );
      }
    }
    if (resolved(it)) {
      const snap = snapshots.get(it.capture.snapshot.sha256);
      if (snap?.status === "retained") {
        const again = applyGateRules(snap.snapshot.content.body as GateReviewBody);
        if (canonicalJson(again) !== canonicalJson(it.capture.deterministic)) {
          finding(
            "baseline-mismatch",
            it.line,
            null,
            `the deterministic result recorded for ${it.capture.itemKey} is not what the rules give on its snapshot`,
          );
        }
      }
    }
  }
  const baselineMismatch = new Set(
    findings.filter((f) => f.kind === "baseline-mismatch").map((f) => f.line),
  );
  /** Settled, labeled, state held: the baselines' scoring set. */
  const scorable = (it: ItemEntry) =>
    resolved(it) && labelOf(it) !== null && stateOf(it) === "held";

  // ── Census ────────────────────────────────────────────────────────────────
  const census: H1Census[] = POPULATIONS.map((population) => {
    const mine = [...idx.items.values()].filter((it) => it.capture.population === population);
    const unlabeled: Record<string, number> = {};
    const principals: Record<string, number> = {};
    const notCalled: Record<string, number> = {};
    const state = { held: 0, changed: 0, unobserved: 0 };
    const labeled = { sentBack: 0, notSentBack: 0, approve: 0, revise: 0, abort: 0 };
    for (const it of mine.filter(resolved)) {
      const label = labelOf(it);
      if (label === null) {
        const r =
          it.settle!.outcome === "labeled"
            ? "reference-corrupt"
            : (it.settle!.reason ?? "unspecified");
        unlabeled[r] = (unlabeled[r] ?? 0) + 1;
        continue;
      }
      const ref = it.settle!.reference!;
      if (label === "sent-back") labeled.sentBack++;
      else labeled.notSentBack++;
      labeled[ref.value]++;
      principals[ref.principal.kind] = (principals[ref.principal.kind] ?? 0) + 1;
      state[stateOf(it)]++;
      if (it.capture.sample.selected && it.attempts.length === 0) {
        const r = it.drift
          ? "state-changed-before-call"
          : (it.prechecks[it.prechecks.length - 1] ?? "no-call-before-action");
        notCalled[r] = (notCalled[r] ?? 0) + 1;
      }
    }
    return {
      population,
      captured: mine.length,
      sampled: mine.filter((it) => it.capture.sample.selected).length,
      notSampled: mine.filter((it) => !it.capture.sample.selected).length,
      pending: mine.filter((it) => !it.settle).length,
      resolved: mine.filter(resolved).length,
      windowClosed: mine.filter((it) => it.settle?.outcome === "window-closed").length,
      labeled,
      unlabeled,
      state,
      principals,
      notCalled,
    };
  });

  // ── Baselines ─────────────────────────────────────────────────────────────
  const deterministic: H1BaselineRow[] = POPULATIONS.map((population) => {
    const set = [...idx.items.values()].filter(
      (it) =>
        it.capture.population === population && scorable(it) && !baselineMismatch.has(it.line),
    );
    return {
      population,
      definition: { ...GATE_RULES_V1_REF },
      scored: set.length,
      agreement: agreementOf(
        set.map((it) => ({ label: labelOf(it)!, column: it.capture.deterministic.classification })),
        RULES_SPEC,
      ),
    };
  });
  const verdict: H1VerdictRow[] = POPULATIONS.map((population) => {
    const set = [...idx.items.values()].filter(
      (it) => it.capture.population === population && scorable(it),
    );
    return {
      population,
      definition: { ...QUALIFICATION_V1_REF },
      scored: set.length,
      agreement: agreementOf(
        set.map((it) => ({ label: labelOf(it)!, column: it.capture.verdict.classification })),
        VERDICT_SPEC,
      ),
      auroc: aurocLowerMeansPositive(
        set
          .filter((it) => it.capture.verdict.rating !== null)
          .map((it) => ({ rating: it.capture.verdict.rating!, label: labelOf(it)! })),
      ),
    };
  });

  // ── Models: resolved items only ───────────────────────────────────────────
  interface Joined {
    item: ItemEntry;
    entry: AttemptEntry;
    cls: H2AttemptClass;
    code: string | null;
    assessment: DecisionAssessment | null;
    identity: ProviderIdentity;
  }
  const joined: Joined[] = [];
  for (const item of [...idx.items.values()].filter(resolved)) {
    for (const entry of item.attempts) {
      const a = entry.attempt;
      const found = byId.get(a.assessmentId) ?? null;
      let cls: H2AttemptClass;
      let code: string | null;
      if (entry.result) {
        cls = entry.result.class;
        code = entry.result.code;
      } else if (found) {
        ({ cls, code } = classOf(found));
        finding(
          "reconciled-in-report",
          entry.line,
          a.attemptId,
          "no result line; classified from the journal",
        );
      } else {
        cls = "unresolved";
        code = null;
      }
      const expects = entry.result ? entry.result.assessmentId !== null : found !== null;
      let assessment: DecisionAssessment | null = null;
      if (expects && !found) {
        finding(
          "assessment-missing",
          entry.line,
          a.attemptId,
          `assessment ${a.assessmentId} is not in the journal`,
        );
      } else if (found) {
        const s = found.subject;
        const problems: string[] = [];
        if (
          s.kind !== "phase-attempt" ||
          s.instanceId !== item.capture.instanceId ||
          s.phaseId !== item.capture.phaseId ||
          s.attempt !== item.capture.attempt
        ) {
          problems.push("subject");
        }
        if (!refEq(found.question, a.question)) problems.push("question");
        if (!refEq(found.snapshot.projection, a.projection)) problems.push("projection");
        if (found.snapshot.sha256 !== a.snapshot) problems.push("snapshot");
        if (found.provider.provider !== a.provider.provider) problems.push("provider");
        if (found.sample !== a.sample) problems.push("sample");
        if (entry.result?.outcome && entry.result.outcome.status !== found.outcome.status)
          problems.push("outcome");
        if (found.mode !== "shadow") {
          finding(
            "not-shadow",
            entry.line,
            a.attemptId,
            `assessment ${found.id} is mode ${found.mode}`,
          );
        } else if (problems.length > 0) {
          finding(
            "assessment-mismatch",
            entry.line,
            a.attemptId,
            `assessment ${found.id} differs in: ${problems.join(", ")}`,
          );
        } else {
          assessment = found;
          if (found.provider.requestedModel !== a.provider.requestedModel) {
            finding(
              "requested-model-differs",
              entry.line,
              a.attemptId,
              `requested ${String(a.provider.requestedModel)}, the runner passed ${String(found.provider.requestedModel)}`,
            );
          }
        }
      }
      joined.push({
        item,
        entry,
        cls,
        code,
        assessment,
        identity: assessment ? assessment.provider : { ...a.provider, reportedModel: null },
      });
    }
  }
  const identityKey = (p: ProviderIdentity) =>
    canonicalJson([p.provider, p.requestedModel, p.reportedModel, p.adapterVersion, p.elicitation]);
  const groups = new Map<string, Joined[]>();
  for (const j of joined) {
    const a = j.entry.attempt;
    const key = canonicalJson([
      j.item.capture.population,
      a.question.id,
      a.question.version,
      a.question.digest,
      a.projection.digest,
      identityKey(j.identity),
    ]);
    const g = groups.get(key) ?? [];
    g.push(j);
    groups.set(key, g);
  }
  const models: H1ModelPopulation[] = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, group]) => {
      const first = group[0];
      const q = first.entry.attempt.question;
      const reg = registry.question(q.id, q.version);
      const definition: "registered" | "missing" | "digest-mismatch" = !reg
        ? "missing"
        : reg.ref.digest !== q.digest
          ? "digest-mismatch"
          : "registered";
      const attempts = Object.fromEntries(ATTEMPT_CLASSES.map((c) => [c, 0])) as Record<
        H2AttemptClass,
        number
      >;
      const refusals: Record<string, number> = {};
      for (const j of group) {
        attempts[j.cls]++;
        if (j.cls === "refused" || j.cls === "missing-input" || j.cls === "construction-error") {
          const k = `${j.cls}:${j.code ?? "unspecified"}`;
          refusals[k] = (refusals[k] ?? 0) + 1;
        }
      }
      const assessed = group.filter((j) => ASSESSED.has(j.cls) && j.assessment !== null);
      const count = (s: string) =>
        assessed.filter((j) => j.assessment!.outcome.status === s).length;
      const excluded: Record<string, number> = {};
      const exclude = (r: string) => (excluded[r] = (excluded[r] ?? 0) + 1);
      const scoredItems: Array<{
        j: Joined;
        label: H1ReferenceLabel;
        column: string;
        p: number | null;
      }> = [];
      for (const j of assessed) {
        const it = j.item;
        const label = labelOf(it);
        if (label === null) {
          exclude(
            `unlabeled:${it.settle!.outcome === "labeled" ? "reference-corrupt" : (it.settle!.reason ?? "unspecified")}`,
          );
          continue;
        }
        const st = stateOf(it);
        if (st !== "held") {
          exclude(`state-${st}`);
          continue;
        }
        const pc = j.entry.postCheck;
        if (!pc) {
          exclude("post-check-missing");
          continue;
        }
        if (!pc.eligible) {
          exclude("action-during-call");
          continue;
        }
        if (pc.sameState !== true) {
          exclude("state-changed-during-call");
          continue;
        }
        const o = j.assessment!.outcome;
        if (o.status === "answered") {
          if (
            !reg ||
            definition !== "registered" ||
            checkOutcome(reg.def.answers, o) !== null ||
            o.answer.kind !== "probability" ||
            o.answer.shape !== "binary"
          ) {
            exclude("invalid-distribution");
            finding(
              "invalid-distribution",
              j.entry.line,
              j.entry.attempt.attemptId,
              "the stored answer does not validate against the question",
            );
            continue;
          }
          scoredItems.push({ j, label, column: binaryPrediction(o.answer.p), p: o.answer.p });
        } else {
          scoredItems.push({
            j,
            label,
            column: o.status === "abstained" ? "abstained" : "failed",
            p: null,
          });
        }
      }
      const calibrated: BinaryCalibrated[] = scoredItems
        .filter((s) => s.p !== null)
        .map((s) => ({ p: s.p!, y: s.label === "sent-back" ? 1 : 0 }));
      const brier = binaryBrier(calibrated);
      const ece = binaryEce(calibrated);
      const noAnswered = "no answered item in the scoring set";
      return {
        population: first.item.capture.population,
        question: { id: q.id, version: q.version, digest: q.digest, definition },
        projection: { ...first.entry.attempt.projection },
        provider: { ...first.identity },
        attempts,
        assessed: assessed.length,
        answered: count("answered"),
        abstained: count("abstained"),
        failed: count("failed"),
        refusals,
        excluded,
        agreement: agreementOf(scoredItems, MODEL_SPEC),
        brier:
          brier === null
            ? { status: "unmeasured", reason: noAnswered }
            : { status: "measured", value: { value: brier, n: calibrated.length } },
        reliability: { minBucket: MIN_BUCKET, buckets: binaryReliability(calibrated) },
        ece:
          ece === null
            ? { status: "unmeasured", reason: `n = ${calibrated.length} < ${MIN_ECE_N}` }
            : { status: "measured", value: { value: ece, n: calibrated.length } },
        paired: {
          deterministic: agreementOf(
            scoredItems.map((s) => ({
              label: s.label,
              column: s.j.item.capture.deterministic.classification,
            })),
            RULES_SPEC,
          ),
          verdict: agreementOf(
            scoredItems.map((s) => ({
              label: s.label,
              column: s.j.item.capture.verdict.classification,
            })),
            VERDICT_SPEC,
          ),
        },
        usage: {
          latencyMs: distribution(assessed.map((j) => j.assessment!.latencyMs)),
          costUsd: totals(assessed.map((j) => j.assessment!.costUsd)),
          tokens: totals(assessed.map((j) => j.assessment!.tokens)),
          snapshotBytes: distribution(assessed.map((j) => j.assessment!.snapshot.bytes)),
        },
      };
    });

  // ── Everything else ───────────────────────────────────────────────────────
  const gatesExcluded: Record<string, number> = {};
  for (const [key, reason] of idx.gates) {
    if (idx.items.has(key)) continue;
    gatesExcluded[reason] = (gatesExcluded[reason] ?? 0) + 1;
  }
  const pendingBy = Object.fromEntries(POPULATIONS.map((p) => [p, 0])) as Record<
    H1Population,
    number
  >;
  for (const it of idx.items.values()) if (!it.settle) pendingBy[it.capture.population]++;

  const spentClasses = new Set<string>([
    "answered",
    "abstained",
    "provider-failed",
    "unrecorded",
    "unknown-outcome",
  ]);
  const spend = {
    attempts: idx.attempts.length,
    spent: idx.attempts.filter((e) => e.result === null || spentClasses.has(e.result.class)).length,
    usdTotal: round6(idx.attempts.reduce((s, e) => s + (e.result?.costUsd ?? 0), 0)),
    usdUnknown: idx.attempts.filter(
      (e) => (e.result === null || spentClasses.has(e.result.class)) && e.result?.costUsd == null,
    ).length,
  };

  const configs: H1ConfigSummary[] = idx.configs.map((c) => ({
    digest: c.digest,
    firstAt: c.at,
    seed: c.config.sampling.seed,
    rate: c.config.sampling.rate,
    arms: c.config.arms.map((a) => ({
      requestedModel: a.requestedModel,
      adapterVersion: a.identity.adapterVersion,
    })),
    limits: { ...c.config.limits },
  }));

  const recorded = (pick: (c: H1Config) => DefinitionRef) =>
    idx.configs.map((c) => pick(c.config).digest);
  const defRow = (
    kind: "question" | "projection" | "rules" | "qualification",
    ref: DefinitionRef | null,
    id: string,
    version: number,
    seen: string[],
  ) => ({
    kind,
    id,
    version,
    digest: ref?.digest ?? seen[0] ?? null,
    status: !ref
      ? ("missing" as const)
      : seen.some((d) => d !== ref.digest)
        ? ("digest-mismatch" as const)
        : ("registered" as const),
  });
  const qreg = registry.question(H1_QUESTION.id, H1_QUESTION.version);
  const preg = qreg
    ? registry.projection(qreg.def.projection.id, qreg.def.projection.version)
    : null;
  const definitions = [
    defRow(
      "question",
      qreg?.ref ?? null,
      H1_QUESTION.id,
      H1_QUESTION.version,
      recorded((c) => c.question),
    ),
    defRow(
      "projection",
      preg?.ref ?? null,
      "gate-review",
      1,
      recorded((c) => c.projection),
    ),
    defRow(
      "rules",
      GATE_RULES_V1_REF,
      GATE_RULES_V1_REF.id,
      GATE_RULES_V1_REF.version,
      recorded((c) => c.rules),
    ),
    defRow(
      "qualification",
      QUALIFICATION_V1_REF,
      QUALIFICATION_V1_REF.id,
      QUALIFICATION_V1_REF.version,
      recorded((c) => c.qualification),
    ),
  ];

  const last = ledger.records[ledger.records.length - 1]?.record ?? null;
  const journalNotices = journal.notices.map((n) => ({
    kind: n.kind,
    segment: n.segment ?? null,
    line: n.line ?? null,
    detail: n.detail,
  }));
  const complete =
    ledger.notices.every((n) => BENIGN_H1_NOTICES.has(n.kind)) &&
    journal.gaps.length === 0 &&
    journal.notices.every((n) => JOURNAL_BENIGN.has(n.kind)) &&
    findings.every((f) => INFORMATIONAL.has(f.kind));

  return {
    report: { ...H1_REPORT_V1 },
    asOf: { seq: ledger.lastSeq, at: last?.at ?? null },
    statement: H1_STATEMENT,
    collection: { start: idx.start, configs },
    definitions,
    gates: { excluded: gatesExcluded },
    census,
    pending: {
      total: Object.values(pendingBy).reduce((a, b) => a + b, 0),
      byPopulation: pendingBy,
    },
    deterministic,
    verdict,
    models,
    spend,
    methods: { ...H1_METHODS },
    integrity: {
      history: complete ? "complete" : "incomplete",
      ledger: ledger.notices.map((n) => ({
        kind: n.kind,
        line: n.line,
        attemptId: null,
        detail: n.detail,
      })),
      journal: { gaps: journal.gaps.length, notices: journalNotices },
      findings,
    },
  };
}

export function renderH1Report(inputs: H1ReplayInputs): string {
  return `${canonicalJson(buildH1Report(inputs))}\n`;
}

/** Replay from disk. Reads the ledger, the snapshot store and the journal; writes nothing. */
export async function replayH1(
  ledger: Pick<H1Ledger, "read">,
  store: Pick<H1SnapshotStore, "load">,
  journal: Pick<DecisionJournal, "read">,
  registry: DecisionRegistry,
): Promise<H1Report> {
  const [l, j] = await Promise.all([ledger.read(), journal.read()]);
  const snapshots = new Map<string, StoredLookup>();
  for (const { record } of l.records) {
    if (record.kind === "capture" && !snapshots.has(record.snapshot.sha256)) {
      snapshots.set(record.snapshot.sha256, await store.load(record.snapshot.sha256));
    }
  }
  return buildH1Report({ ledger: l, snapshots, journal: j, registry });
}
