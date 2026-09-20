import { Fragment, useState } from "react";
import { Drawer, Skeleton, StatusPill, isMarkdown } from "../ds";
import { Markdown } from "../ds/Markdown";
import { useArtifactContent, useGateReview } from "../useGateReview";
import type { GateActionOptions } from "../useOverview";
import type {
  AcceptanceCriterion,
  ChangeProposalPreview,
  ChangeProposalWarning,
  ChangeRuleState,
  EvidenceSource,
  KnowledgeDeltaPreview,
  KnowledgeDeltaWarning,
  PhaseArtifact,
  PhaseReview,
  PreviewClaim,
  PreviewEvidence,
  PreviewJustification,
  PreviewRevision,
  RuleVerificationPreview,
  RuleVerificationPreviewEntry,
  VerificationEvidence,
} from "../types";

/**
 * The one place a human decides on a gate.
 *
 * A gated phase parks with whatever its agent left — a payload, a structured
 * result, Argus's own checks, and the files in its artifact directory. Before
 * this drawer the board offered Approve and Revise beside a phase with no way to
 * see any of that; approving was a leap of faith and the palette could even do
 * it blind. Now every other surface (the board's focus panel, the situation
 * strip, the palette, `argus tail`) *points here*, and the two buttons exist in
 * this component and nowhere else in the web UI.
 *
 * The review is read-only. Approve continues the pipeline with exactly what is
 * shown; Revise sends a note back and the phase runs again — the revision *is*
 * the note, so nothing here edits an artifact.
 */

export interface GateSelection {
  instanceId: string;
  phaseId: string;
  pipelineName: string;
  /** Viewport Y of the opener, so the drawer grows from that row. */
  originY?: number;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Fragment>
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-[12.5px] text-ink-dim">{children}</dd>
    </Fragment>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
      {children}
    </h3>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The prose a payload carries, in the order it is shown, and the fields left
 *  once that prose is lifted out. `reason` is one sentence, so it stays plain
 *  text; `summary` and `last_assistant_message` are the agent's own writing,
 *  which Claude Code (and the agent's closing note in general) formats as
 *  markdown. */
const PROSE_FIELDS = ["reason", "summary", "last_assistant_message"] as const;

function splitPayload(value: Record<string, unknown>) {
  const prose: Partial<Record<(typeof PROSE_FIELDS)[number], string>> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if ((PROSE_FIELDS as readonly string[]).includes(k) && typeof v === "string" && v.trim()) {
      prose[k as (typeof PROSE_FIELDS)[number]] = v;
    } else {
      rest[k] = v;
    }
  }
  return { prose, rest };
}

/**
 * The agent's closing words.
 *
 * A phase's payload is usually the whole event the runtime handed the Stop
 * hook — session id, transcript path, permission mode, background tasks — with
 * the agent's final message as one field among a dozen, plus the `reason`
 * and `failureClass` Argus attached. What a reviewer wants is the reason and
 * the note; the rest is diagnostic, so it folds behind a toggle and only
 * comes forward when there is no prose to show instead. A bare string is
 * treated as the note itself.
 */
function Payload({ value }: { value: unknown }) {
  if (value == null) return null;
  if (typeof value === "string") {
    return <ClosingNote source={value} />;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return <RawPayload value={value} />;
  }
  const { prose, rest } = splitPayload(value as Record<string, unknown>);
  const hasProse = Object.keys(prose).length > 0;
  const hasRest = Object.keys(rest).length > 0;
  if (!hasProse) return <RawPayload value={value} />;
  return (
    <div className="flex flex-col gap-2">
      {prose.reason && (
        <p
          data-testid="gate-reason"
          className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink"
        >
          {prose.reason}
        </p>
      )}
      {prose.summary && <ClosingNote source={prose.summary} />}
      {prose.last_assistant_message && <ClosingNote source={prose.last_assistant_message} />}
      {hasRest && (
        <details>
          <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint hover:text-ink-dim">
            Raw payload
          </summary>
          <div className="mt-2">
            <RawPayload value={rest} />
          </div>
        </details>
      )}
    </div>
  );
}

function ClosingNote({ source }: { source: string }) {
  return (
    <div
      data-testid="gate-closing-note"
      className="rounded-lg border border-line bg-surface px-4 py-3"
    >
      <Markdown source={source} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
    </div>
  );
}

function RawPayload({ value }: { value: unknown }) {
  return (
    <pre
      data-testid="gate-raw-payload"
      className="max-h-[30vh] overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-ink-dim"
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Verification({ report }: { report: NonNullable<PhaseReview["verification"]> }) {
  return (
    <ul data-testid="gate-verification" className="flex flex-col gap-1">
      {report.checks.map((c, i) => (
        <li key={i} className="flex items-baseline gap-2 text-[12px]">
          <span
            aria-hidden="true"
            className={
              c.status === "passed"
                ? "text-ok"
                : c.status === "failed"
                  ? "text-fail"
                  : "text-ink-faint"
            }
          >
            {c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "…"}
          </span>
          <span className="text-ink-dim">{c.label}</span>
          {c.detail && <span className="min-w-0 break-words text-ink-faint">— {c.detail}</span>}
        </li>
      ))}
      {report.checks.length === 0 && (
        <li className="text-[12px] text-ink-faint">
          {report.status === "running" ? "Checks still running." : "No checks declared."}
        </li>
      )}
    </ul>
  );
}

/**
 * Candidate knowledge — the review surface for a staged KnowledgeDelta
 * (Phase 5).
 *
 * A discovery phase's real output is not a file: it is a set of proposed
 * business rules with the evidence behind them. Without this panel the only
 * way to see what an agent proposed before approving it would be to read its
 * transcript, which is exactly what the Knowledge Ledger exists to replace.
 *
 * Deliberately a structured table and nothing more. No graph, no editor, no
 * ontology browser: the two decisions a reviewer makes here are Approve and
 * Revise, and what they need in order to make them is the rule, its evidence,
 * what a revision would replace, and what Argus already knows is questionable.
 *
 * A proposed claim is labelled `local:<id>` because that is honestly all it
 * is until the commit mints an identity — showing a canonical-looking id for
 * something that may never exist would be a lie the drawer tells once and the
 * reviewer believes forever.
 */
function describeSource(source: EvidenceSource): string {
  switch (source.type) {
    case "source-code": {
      const range =
        source.startLine !== undefined
          ? `:${source.startLine}${source.endLine !== undefined && source.endLine !== source.startLine ? `-${source.endLine}` : ""}`
          : source.line !== undefined
            ? `:${source.line}`
            : "";
      const at = source.gitHead ? `@${source.gitHead.slice(0, 8)}` : "";
      const symbol = source.symbol ? ` · ${source.symbol}` : "";
      return `${source.path}${range}${at}${symbol}`;
    }
    case "git-commit":
      return `commit ${source.sha.slice(0, 8)}${source.repository ? ` (${source.repository})` : ""}`;
    case "document":
      return source.title ? `${source.title} — ${source.uri}` : source.uri;
    case "human":
      return source.who;
    case "run":
      return `run ${source.runId}`;
    case "phase":
      return `${source.instanceId} · ${source.phaseId}`;
    case "verification":
      return `verification of ${source.phaseId}`;
    case "artifact":
      return `${source.phaseId} · ${source.path}`;
  }
}

function KindTag({ kind }: { kind: string }) {
  const tone =
    kind === "business-rule"
      ? "border-ok/40 text-ok"
      : kind === "assumption"
        ? "border-await/40 text-await"
        : "border-line text-ink-faint";
  return (
    <span
      className={`rounded border px-1 font-mono text-[8.5px] uppercase tracking-[0.1em] ${tone}`}
    >
      {kind}
    </span>
  );
}

function EvidenceList({ evidence }: { evidence: PreviewEvidence[] }) {
  if (evidence.length === 0) {
    return (
      <p className="mt-1 text-[11px] text-fail" data-testid="candidate-no-evidence">
        No evidence attached.
      </p>
    );
  }
  return (
    <ul className="mt-1 flex flex-col gap-0.5" aria-label="Evidence">
      {evidence.map((e, i) => (
        <li key={i} className="flex min-w-0 items-baseline gap-2 text-[11px]">
          <span
            aria-hidden="true"
            className={e.direction === "opposes" ? "text-fail" : "text-ink-faint"}
          >
            {e.direction === "opposes" ? "✗" : "→"}
          </span>
          <span className="min-w-0 break-words font-mono text-ink-dim">
            {describeSource(e.source)}
          </span>
          {e.note && <span className="min-w-0 break-words text-ink-faint">— {e.note}</span>}
        </li>
      ))}
    </ul>
  );
}

function JustificationList({ justifications }: { justifications: PreviewJustification[] }) {
  if (justifications.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5" aria-label="Justifications">
      {justifications.map((j, i) => (
        <li key={i} className="min-w-0 break-words font-mono text-[11px] text-ink-faint">
          {j.direction === "opposes" ? "opposed by" : "from"}{" "}
          {j.premises.map((p) => p.display).join(" + ")}
          {j.note ? ` — ${j.note}` : ""}
        </li>
      ))}
    </ul>
  );
}

function CandidateClaim({ claim }: { claim: PreviewClaim }) {
  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <KindTag kind={claim.kind} />
        <span className="font-mono text-[10px] text-ink-faint">{claim.ref.display}</span>
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink">{claim.statement}</p>
      <EvidenceList evidence={claim.evidence} />
      <JustificationList justifications={claim.justifications} />
    </li>
  );
}

function CandidateRevision({ revision }: { revision: PreviewRevision }) {
  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        {revision.kind && <KindTag kind={revision.kind} />}
        <span className="font-mono text-[10px] text-ink-faint">
          {revision.claimId} v{revision.expectedRevision} → v{revision.expectedRevision + 1}
        </span>
        {revision.stale && (
          <span className="rounded border border-fail/40 px-1 font-mono text-[8.5px] uppercase tracking-[0.1em] text-fail">
            stale
          </span>
        )}
      </div>
      {revision.current && (
        <p className="mt-1 text-[12px] leading-relaxed text-ink-faint line-through">
          {revision.current.statement}
        </p>
      )}
      <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink">{revision.statement}</p>
      {revision.revisionNote && (
        <p className="mt-0.5 text-[11px] text-ink-faint">{revision.revisionNote}</p>
      )}
      <EvidenceList evidence={revision.evidence} />
      <JustificationList justifications={revision.justifications} />
    </li>
  );
}

function Warnings({ warnings }: { warnings: KnowledgeDeltaWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul data-testid="candidate-warnings" className="mt-2 flex flex-col gap-1" aria-label="Warnings">
      {warnings.map((w, i) => (
        <li key={i} className="flex min-w-0 items-baseline gap-2 text-[11.5px] text-await">
          <span aria-hidden="true">!</span>
          <span className="min-w-0 break-words">{w.message}</span>
        </li>
      ))}
    </ul>
  );
}

function CandidateKnowledge({
  previews,
  discovery,
  canApprove,
}: {
  previews: KnowledgeDeltaPreview[];
  discovery: PhaseReview["discovery"];
  /** Approve is offered: the candidates are still on their way to canonical.
   *  On a failed phase they are diagnostic — the delta never commits. */
  canApprove: boolean;
}) {
  const claims = previews.flatMap((p) => p.proposedClaims);
  const revisions = previews.flatMap((p) => p.proposedRevisions);
  const warnings = previews.flatMap((p) => p.warnings);
  const consumed = previews.flatMap((p) => p.consumed);
  return (
    <div data-testid="gate-candidate-knowledge" className="flex flex-col gap-2">
      <p className="text-[12px] text-ink-faint">
        {discovery
          ? `${discovery.candidates} candidate${discovery.candidates === 1 ? "" : "s"} · ${discovery.newRules} new rule${discovery.newRules === 1 ? "" : "s"} · ${discovery.revisions} revision${discovery.revisions === 1 ? "" : "s"} · ${discovery.assumptions} assumption${discovery.assumptions === 1 ? "" : "s"}`
          : `${claims.length + revisions.length} proposed claim${claims.length + revisions.length === 1 ? "" : "s"}`}
        .{" "}
        {canApprove
          ? "Nothing here is canonical yet; approving commits it to the Knowledge Ledger."
          : "None of this became canonical: the phase did not reach its commit."}
      </p>
      <Warnings warnings={warnings} />
      {revisions.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Proposed revisions">
          {revisions.map((r, i) => (
            <CandidateRevision key={`${r.claimId}-${i}`} revision={r} />
          ))}
        </ul>
      )}
      {claims.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Proposed claims">
          {claims.map((c, i) => (
            <CandidateClaim key={`${c.ref.display}-${i}`} claim={c} />
          ))}
        </ul>
      )}
      {consumed.length > 0 && (
        <p className="font-mono text-[10.5px] text-ink-faint">
          consumed: {consumed.map((c) => c.ref).join(", ")}
        </p>
      )}
    </div>
  );
}

/**
 * Business-rule verification — the review surface for a staged conformance
 * proposal (Phase 6).
 *
 * The one thing this panel must never let a reviewer confuse is the one the
 * whole phase exists to separate:
 *
 *   RULE SUPPORT               is the rule itself well founded?
 *   IMPLEMENTATION CONFORMANCE does the code do what it says?
 *
 * So every row shows both, side by side — `supported · VIOLATED` is the normal
 * reading of a bug, and a reviewer who saw only "violated" would eventually
 * start revising rules whose implementations were merely in breach.
 *
 * Grouped by outcome, compact, and honest about `unverifiable`: it is given
 * its own group with the verifier's reason rather than being folded in with
 * the rules that hold.
 */
function describeVerificationEvidence(e: VerificationEvidence): string {
  switch (e.type) {
    case "check":
      return `check: ${e.label}${e.status ? ` (${e.status}${e.exitCode != null ? `, exit ${e.exitCode}` : ""})` : ""}`;
    case "source-code":
      return describeSource(e);
    case "artifact":
      return `${e.artifact.location}: ${e.artifact.path}`;
    case "observation":
      return e.note;
  }
}

const OUTCOME_TONE: Record<string, string> = {
  holds: "border-ok/40 text-ok",
  violated: "border-fail/40 text-fail",
  unverifiable: "border-await/40 text-await",
};

function VerificationEvidenceList({ evidence }: { evidence: VerificationEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5" aria-label="Conformance evidence">
      {evidence.map((e, i) => {
        const failed = e.type === "check" && e.status === "failed";
        return (
          <li key={i} className="flex min-w-0 items-baseline gap-2 text-[11px]">
            <span aria-hidden="true" className={failed ? "text-fail" : "text-ok"}>
              {failed ? "✗" : "✓"}
            </span>
            <span className="min-w-0 break-words font-mono text-ink-dim">
              {describeVerificationEvidence(e)}
            </span>
            {"note" in e && e.note && e.type !== "observation" && (
              <span className="min-w-0 break-words text-ink-faint">— {e.note}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function VerificationRow({ entry }: { entry: RuleVerificationPreviewEntry }) {
  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={`rounded border px-1 font-mono text-[8.5px] uppercase tracking-[0.1em] ${
            OUTCOME_TONE[entry.outcome] ?? "border-line text-ink-faint"
          }`}
        >
          {entry.outcome}
        </span>
        <span className="font-mono text-[10px] text-ink-faint">{entry.ref}</span>
        {entry.support && (
          <span
            className="font-mono text-[9.5px] text-ink-faint"
            title="The rule's own support. Independent of whether the code conforms."
          >
            rule: {entry.support}
          </span>
        )}
      </div>
      {entry.statement && (
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink">{entry.statement}</p>
      )}
      {entry.reason && <p className="mt-0.5 text-[11.5px] text-await">{entry.reason}</p>}
      {entry.note && <p className="mt-0.5 text-[11px] text-ink-faint">{entry.note}</p>}
      <VerificationEvidenceList evidence={entry.evidence} />
    </li>
  );
}

function VerificationGroup({
  label,
  entries,
}: {
  label: string;
  entries: RuleVerificationPreviewEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
        {label} ({entries.length})
      </p>
      <ul className="flex flex-col gap-1.5" aria-label={label}>
        {entries.map((e) => (
          <VerificationRow key={`${e.ref}-${e.outcome}`} entry={e} />
        ))}
      </ul>
    </div>
  );
}

function RuleVerification({
  previews,
  summary,
  canApprove,
}: {
  previews: RuleVerificationPreview[];
  summary: PhaseReview["ruleVerification"];
  canApprove: boolean;
}) {
  const holds = previews.flatMap((p) => p.holds);
  const violated = previews.flatMap((p) => p.violated);
  const unverifiable = previews.flatMap((p) => p.unverifiable);
  const missing = previews.flatMap((p) => p.missing);
  const head = previews.find((p) => p.gitHead);
  return (
    <div data-testid="gate-rule-verification" className="flex flex-col gap-2">
      <p className="text-[12px] text-ink-faint">
        {`${summary?.holds ?? holds.length} holds · ${summary?.violated ?? violated.length} violated · ${
          summary?.unverifiable ?? unverifiable.length
        } unverifiable`}
        {head?.gitHead ? ` · at ${head.gitHead.slice(0, 8)}` : ""}.{" "}
        {canApprove
          ? "Nothing here is durable yet; approving records it against these exact rule revisions."
          : "None of this became durable: the phase did not reach its commit."}
      </p>
      {missing.length > 0 && (
        <p data-testid="gate-verification-missing" className="text-[11.5px] text-fail">
          No outcome submitted for {missing.join(", ")}.
        </p>
      )}
      <VerificationGroup label="Holds" entries={holds} />
      <VerificationGroup label="Violated" entries={violated} />
      <VerificationGroup label="Unverifiable" entries={unverifiable} />
      {previews.some((p) => p.summary) && (
        <p className="text-[11.5px] text-ink-faint">
          {previews
            .map((p) => p.summary)
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
    </div>
  );
}

/**
 * Change intent — the review surface for a staged ChangeProposal (Phase 7).
 *
 * The one decision a reviewer makes here is whether the *intent* is right, and
 * to make it they need four things that no transcript shows compactly:
 *
 *   REQUESTED   what somebody asked for, verbatim
 *   CURRENT     what the domain says now, and whether the code does it
 *   PROPOSED    the exact revisions and new claims that would follow
 *   JUDGED BY   the acceptance criteria, plus what is still unresolved
 *
 * The panel keeps the three kinds of statement visibly apart, because
 * collapsing any two of them is how a request quietly becomes a rule, or a
 * bug quietly becomes a requirement:
 *
 *   request  ≠  rule  ≠  implementation
 *
 * So a current rule shows its support *and* its conformance side by side, a
 * proposed revision is rendered by the same candidate-knowledge machinery as
 * any other staged delta, and acceptance criteria are shown under their own
 * heading — never as claims.
 */
function ReadinessTag({ readiness }: { readiness: ChangeProposalPreview["readiness"] }) {
  const ready = readiness === "ready";
  return (
    <span
      data-testid="change-readiness"
      className={`rounded border px-1 font-mono text-[8.5px] uppercase tracking-[0.1em] ${
        ready ? "border-ok/40 text-ok" : "border-await/40 text-await"
      }`}
      title={
        ready
          ? "Every relevant rule is accounted for and nothing is unresolved."
          : "Unresolved questions or uncovered rule changes: this proposal cannot drive an implementation."
      }
    >
      {readiness}
    </span>
  );
}

const CONFORMANCE_TONE: Record<string, string> = {
  holds: "text-ok",
  violated: "text-fail",
  unverifiable: "text-await",
  unverified: "text-ink-faint",
};

function CurrentRule({ rule }: { rule: ChangeRuleState }) {
  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <KindTag kind={rule.kind} />
        <span className="font-mono text-[10px] text-ink-faint">{rule.ref}</span>
        <span className="font-mono text-[9.5px] text-ink-faint" title="The rule's own support.">
          rule: {rule.support}
        </span>
        <span
          className={`font-mono text-[9.5px] ${CONFORMANCE_TONE[rule.conformance] ?? "text-ink-faint"}`}
          title="What the implementation does. Independent of whether the rule is well founded."
        >
          impl: {rule.conformance}
          {rule.conformanceAt ? ` @${rule.conformanceAt.slice(0, 8)}` : ""}
        </span>
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink">{rule.statement}</p>
    </li>
  );
}

function ChangeWarnings({ warnings }: { warnings: ChangeProposalWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul data-testid="change-warnings" className="mt-1 flex flex-col gap-1" aria-label="Warnings">
      {warnings.map((w, i) => (
        <li key={i} className="flex min-w-0 items-baseline gap-2 text-[11.5px] text-await">
          <span aria-hidden="true">!</span>
          <span className="min-w-0 break-words">{w.message}</span>
        </li>
      ))}
    </ul>
  );
}

function AcceptanceCriteria({ criteria }: { criteria: AcceptanceCriterion[] }) {
  if (criteria.length === 0) return null;
  return (
    <ol
      data-testid="change-acceptance-criteria"
      className="flex flex-col gap-1"
      aria-label="Acceptance criteria"
    >
      {criteria.map((c) => (
        <li key={c.id} className="flex min-w-0 items-baseline gap-2 text-[12px]">
          <span className="font-mono text-[10px] text-ink-faint">{c.id}</span>
          <span className="rounded border border-line px-1 font-mono text-[8.5px] uppercase tracking-[0.1em] text-ink-faint">
            {c.kind}
          </span>
          <span className="min-w-0 break-words text-ink">{c.statement}</span>
        </li>
      ))}
    </ol>
  );
}

function ChangeProposalPanel({
  previews,
  summary,
  canApprove,
}: {
  previews: ChangeProposalPreview[];
  summary: PhaseReview["changeIntent"];
  canApprove: boolean;
}) {
  return (
    <div data-testid="gate-change-proposal" className="flex flex-col gap-3">
      {previews.map((p) => {
        const revisions = p.semantic?.proposedRevisions ?? [];
        const claims = p.semantic?.proposedClaims ?? [];
        const decisions = claims.filter((c) => c.kind === "decision");
        const others = claims.filter((c) => c.kind !== "decision");
        return (
          <div key={p.proposalId} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <ReadinessTag readiness={p.readiness} />
              <span className="font-mono text-[10px] text-ink-faint">{p.request.id}</span>
            </div>
            <p data-testid="change-request" className="text-[12.5px] leading-relaxed text-ink">
              {p.request.summary}
            </p>
            {p.request.details && (
              <p className="text-[11.5px] leading-relaxed text-ink-faint">{p.request.details}</p>
            )}
            <p className="text-[12px] text-ink-faint">
              {`${summary?.revised ?? revisions.length} revision${(summary?.revised ?? revisions.length) === 1 ? "" : "s"} · ${summary?.created ?? claims.length} new claim${(summary?.created ?? claims.length) === 1 ? "" : "s"} · ${summary?.preserved ?? p.preserved.length} preserved · ${p.acceptanceCriteria.length} criteri${p.acceptanceCriteria.length === 1 ? "on" : "a"}`}
              .{" "}
              {canApprove
                ? "Nothing here is canonical yet; approving commits the semantic change and records the request that caused it."
                : "None of this became canonical: the phase did not reach its commit."}
            </p>
            <ChangeWarnings warnings={p.warnings} />
            {p.semantic?.warnings && p.semantic.warnings.length > 0 && (
              <Warnings warnings={p.semantic.warnings} />
            )}

            {p.current.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                  Current ({p.current.length})
                </p>
                <ul className="flex flex-col gap-1.5" aria-label="Current rules">
                  {p.current.map((r) => (
                    <CurrentRule key={r.ref} rule={r} />
                  ))}
                </ul>
              </div>
            )}

            {(revisions.length > 0 || others.length > 0) && (
              <div className="flex flex-col gap-1">
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                  Proposed ({revisions.length + others.length})
                </p>
                {revisions.length > 0 && (
                  <ul className="flex flex-col gap-1.5" aria-label="Proposed revisions">
                    {revisions.map((r, i) => (
                      <CandidateRevision key={`${r.claimId}-${i}`} revision={r} />
                    ))}
                  </ul>
                )}
                {others.length > 0 && (
                  <ul className="flex flex-col gap-1.5" aria-label="Proposed claims">
                    {others.map((c, i) => (
                      <CandidateClaim key={`${c.ref.display}-${i}`} claim={c} />
                    ))}
                  </ul>
                )}
              </div>
            )}

            {p.preserved.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                  Preserved ({p.preserved.length})
                </p>
                <ul data-testid="change-preserved" className="flex flex-col gap-0.5">
                  {p.preserved.map((c) => (
                    <li key={c.ref} className="flex min-w-0 items-baseline gap-2 text-[11.5px]">
                      <span aria-hidden="true" className="text-ok">
                        ✓
                      </span>
                      <span className="font-mono text-[10px] text-ink-faint">{c.ref}</span>
                      <span className="min-w-0 break-words text-ink-dim">{c.statement}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {decisions.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                  Decisions ({decisions.length})
                </p>
                <ul className="flex flex-col gap-1.5" aria-label="Decisions">
                  {decisions.map((c, i) => (
                    <CandidateClaim key={`${c.ref.display}-${i}`} claim={c} />
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                Acceptance criteria ({p.acceptanceCriteria.length})
              </p>
              {p.acceptanceCriteria.length === 0 ? (
                <p className="text-[11.5px] text-fail">
                  None. There is no observable way to judge whether this change was implemented.
                </p>
              ) : (
                <AcceptanceCriteria criteria={p.acceptanceCriteria} />
              )}
            </div>

            <div className="flex flex-col gap-1">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                Unresolved ({p.unresolved.length})
              </p>
              {p.unresolved.length === 0 ? (
                <p data-testid="change-unresolved-none" className="text-[11.5px] text-ink-faint">
                  none
                </p>
              ) : (
                <ul data-testid="change-unresolved" className="flex flex-col gap-0.5">
                  {p.unresolved.map((q) => (
                    <li key={q.id} className="flex min-w-0 items-baseline gap-2 text-[12px]">
                      <span className="font-mono text-[10px] text-ink-faint">{q.id}</span>
                      <span className="min-w-0 break-words text-await">{q.question}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {p.summary && <p className="text-[11.5px] text-ink-faint">{p.summary}</p>}
          </div>
        );
      })}
    </div>
  );
}

function ArtifactList({
  artifacts,
  selected,
  onSelect,
}: {
  artifacts: PhaseArtifact[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <ul aria-label="Artifacts" className="flex flex-col gap-0.5">
      {artifacts.map((a) => {
        const active = a.path === selected;
        return (
          <li key={a.path}>
            <button
              type="button"
              onClick={() => onSelect(a.path)}
              aria-current={active ? "true" : undefined}
              className={`flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left transition duration-(--duration-quick) hover:bg-surface-2 ${
                active ? "bg-surface-2 text-ink" : "text-ink-dim"
              }`}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{a.path}</span>
              {a.required && (
                <span className="rounded border border-await/40 px-1 font-mono text-[8.5px] uppercase tracking-[0.1em] text-await">
                  required
                </span>
              )}
              {!a.text && (
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
                  binary
                </span>
              )}
              <span className="font-mono text-[10px] text-ink-faint">{formatBytes(a.bytes)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ArtifactViewer({ selection, path }: { selection: GateSelection; path: string }) {
  const { content, loading, error } = useArtifactContent(
    selection.instanceId,
    selection.phaseId,
    path,
  );
  if (loading) {
    return (
      <div role="status" aria-busy="true" className="mt-3">
        <span className="sr-only">Loading {path}…</span>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-4/5" />
        <Skeleton className="mt-2 h-3 w-2/3" />
      </div>
    );
  }
  if (error) {
    return (
      <p role="alert" className="mt-3 text-[12px] text-fail">
        Couldn't load {path}: {error}
      </p>
    );
  }
  if (!content) return null;
  if (!content.text) {
    return (
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1.5">
        <Field label="file">
          <span className="font-mono">{content.path}</span>
        </Field>
        <Field label="size">{formatBytes(content.bytes)}</Field>
        <Field label="modified">{new Date(content.modifiedAt).toLocaleString()}</Field>
        <Field label="note">Binary — not shown here.</Field>
      </dl>
    );
  }
  const body = content.content ?? "";
  return (
    <div data-testid="artifact-viewer" className="mt-3">
      {content.truncated && (
        <p className="mb-2 text-[10.5px] text-ink-faint">
          Showing the first {formatBytes(body.length)} of {formatBytes(content.bytes)}.
        </p>
      )}
      {isMarkdown(content.path) ? (
        <div className="rounded-lg border border-line bg-surface px-4 py-3">
          <Markdown source={body} />
        </div>
      ) : (
        <pre
          data-testid="artifact-raw"
          className="max-h-[50vh] overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-ink-dim"
        >
          {body}
        </pre>
      )}
    </div>
  );
}

const BUTTON =
  "rounded-md border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] transition-transform duration-(--duration-press) disabled:opacity-40 motion-safe:active:scale-[0.97]";

interface GateActions {
  approve: (instanceId: string, opts?: GateActionOptions) => Promise<unknown>;
  revise: (instanceId: string, note?: string, opts?: GateActionOptions) => Promise<unknown>;
}

export function GateDrawer({
  selection,
  onClose,
  approve,
  revise,
}: GateActions & {
  selection: GateSelection | null;
  onClose: () => void;
}) {
  const { review, loading, error } = useGateReview(
    selection?.instanceId ?? null,
    selection?.phaseId ?? null,
  );
  if (!selection) return <Drawer open={false} title="" onClose={onClose} children={null} />;
  // Fresh state per gate: a different phase, or the same one on a new attempt,
  // must not inherit a half-typed note or a stale "approved" line — so the
  // panel is keyed on both and simply remounts.
  return (
    <GatePanel
      key={`${selection.instanceId}/${selection.phaseId}@${review?.attempt ?? "?"}`}
      selection={selection}
      review={review}
      loading={loading}
      error={error}
      onClose={onClose}
      approve={approve}
      revise={revise}
    />
  );
}

function GatePanel({
  selection,
  review,
  loading,
  error,
  onClose,
  approve,
  revise,
}: GateActions & {
  selection: GateSelection;
  review: PhaseReview | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  // Default to the first required artifact, else the first text one, so a
  // gate with one report opens straight onto it.
  const artifacts = review?.artifacts ?? [];
  const defaultPath =
    artifacts.find((a) => a.required && a.text)?.path ??
    artifacts.find((a) => a.text)?.path ??
    artifacts[0]?.path ??
    null;
  const shownPath =
    selectedPath && artifacts.some((a) => a.path === selectedPath) ? selectedPath : defaultPath;

  // On success busy stays true: the gate is expected to leave the board on the
  // next `pipelines:changed`, which also closes the double-click window. A
  // polite status line says what was accepted until then.
  const run = (action: () => Promise<unknown>, sentLabel: string) => {
    setBusy(true);
    setErr(null);
    void action()
      .then(() => setSent(sentLabel))
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : String(e));
        setBusy(false);
      });
  };

  const gated = review?.status === "awaiting-approval";
  const failed = review?.status === "failed";
  const retry = failed && (review?.payload as { kind?: string } | null)?.kind === "restarted";
  const reviseLabel = retry ? "Retry" : "Revise";
  const noteRequired = gated;
  const target: GateActionOptions = { phaseId: selection.phaseId };

  return (
    <Drawer
      open
      onClose={onClose}
      originY={selection.originY}
      title={review?.phaseName ?? selection.phaseId}
      subtitle={`${selection.pipelineName}${review ? ` · attempt ${review.attempt + 1}` : ""}`}
      footer={
        review && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {review.canApprove && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(() => approve(selection.instanceId, target), "Approved — pipeline resuming")
                  }
                  className={`${BUTTON} border-ok bg-ok/10 text-ok`}
                >
                  Approve
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => setNoteOpen((o) => !o)}
                aria-expanded={noteOpen}
                className={`${BUTTON} border-await bg-await/10 text-await`}
              >
                {reviseLabel}
              </button>
              <span className="ml-auto">
                <StatusPill status={gated ? "await" : "failed"} />
              </span>
            </div>
            {review.canApprove && !noteOpen && (
              <p className="text-[11px] text-ink-faint">
                Approve continues the pipeline with exactly what is shown here.
              </p>
            )}
            {noteOpen && (
              <div className="flex flex-col gap-1.5">
                <p className="text-[11px] text-ink-faint">
                  {retry
                    ? "Runs the phase again. A note is optional."
                    : "Sends it back to the agent with your note; this attempt's files are discarded and the phase runs again."}
                </p>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    aria-label="Revision note"
                    placeholder={noteRequired ? "What should change?" : "Note (optional)"}
                    className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint"
                  />
                  <button
                    type="button"
                    disabled={busy || (noteRequired && note.trim() === "")}
                    onClick={() =>
                      run(
                        () => revise(selection.instanceId, note.trim() || undefined, target),
                        retry
                          ? "Retry sent — phase restarting"
                          : "Revision sent — phase restarting",
                      )
                    }
                    className={`${BUTTON} border-await bg-await/10 text-await`}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
            {sent && !err && (
              <p role="status" className="font-mono text-[10px] text-ok">
                {sent}
              </p>
            )}
            {err && (
              <p role="alert" className="font-mono text-[10px] text-fail">
                {err}
              </p>
            )}
          </div>
        )
      }
    >
      {loading && !review ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the review…</span>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-4/5" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ) : error && !review ? (
        <p role="alert" className="text-[12px] text-fail">
          Couldn't load the review: {error}
        </p>
      ) : review ? (
        <div className="flex flex-col gap-5">
          <section>
            <Heading>{gated ? "Waiting on you" : "What went wrong"}</Heading>
            {gated && (
              <p className="mb-2 text-[12px] text-ink-faint">
                The pipeline is paused here until you decide.
              </p>
            )}
            {review.payload != null ? (
              <Payload value={review.payload} />
            ) : (
              <p className="text-[12px] text-ink-faint">The agent left no closing note.</p>
            )}
          </section>

          {review.result !== undefined && (
            <section>
              <Heading>Result</Heading>
              <pre
                data-testid="gate-result"
                className="max-h-[30vh] overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-ink-dim"
              >
                {JSON.stringify(review.result, null, 2)}
              </pre>
            </section>
          )}

          {review.verification && (
            <section>
              <Heading>Checks</Heading>
              <Verification report={review.verification} />
            </section>
          )}

          {review.knowledge && review.knowledge.length > 0 && (
            <section>
              <Heading>Candidate knowledge</Heading>
              <CandidateKnowledge
                previews={review.knowledge}
                discovery={review.discovery}
                canApprove={review.canApprove}
              />
            </section>
          )}

          {review.changeProposals && review.changeProposals.length > 0 && (
            <section>
              <Heading>Change intent</Heading>
              <ChangeProposalPanel
                previews={review.changeProposals}
                summary={review.changeIntent}
                canApprove={review.canApprove}
              />
            </section>
          )}

          {review.ruleVerifications && review.ruleVerifications.length > 0 && (
            <section>
              <Heading>Business-rule verification</Heading>
              <RuleVerification
                previews={review.ruleVerifications}
                summary={review.ruleVerification}
                canApprove={review.canApprove}
              />
            </section>
          )}

          <section>
            <Heading>Artifacts</Heading>
            {artifacts.length === 0 ? (
              <p data-testid="gate-no-artifacts" className="text-[12px] text-ink-faint">
                This phase left no files.
                {review.canApprove ? " Approving continues with the summary above." : ""}
              </p>
            ) : (
              <Fragment>
                {review.truncated && (
                  <p className="mb-1.5 text-[10.5px] text-ink-faint">
                    Showing the first {artifacts.length} files; more exist on disk.
                  </p>
                )}
                <ArtifactList
                  artifacts={artifacts}
                  selected={shownPath}
                  onSelect={setSelectedPath}
                />
                {shownPath && (
                  <ArtifactViewer
                    key={`${shownPath}@${review.attempt}`}
                    selection={selection}
                    path={shownPath}
                  />
                )}
              </Fragment>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
