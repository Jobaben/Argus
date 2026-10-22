import { Drawer } from "../ds/Drawer";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Icon,
  Skeleton,
  StatusPill,
  TimeAgo,
  chipClass,
  fieldClass,
  isMarkdown,
  labelClass,
  type DsStatus,
  type OverviewRow,
} from "../ds";
import { Markdown } from "../ds/Markdown";
import { useConfirm } from "../ds/useConfirm";
import { SpawnTaskList } from "./SpawnBoard";
import {
  childPipelineName,
  childSelection,
  countsLine,
  keyList,
  reviewTaskRows,
  taskCounts,
} from "./spawnTasks";
import { useArtifactContent, useGateReview } from "../useGateReview";
import { splitOutcome } from "./outcome";
import { reasonText, tellOnce } from "./failureReason";
import { sentenceStart } from "./text";
import { KIND_TERMS, TERMS, type TermId } from "./knowledgeGlossary";
import type { GateActionOptions } from "../useOverview";
import type {
  AcceptanceCriterion,
  AcceptanceVerificationPreview,
  AcceptanceVerificationPreviewEntry,
  ChangeProposalPreview,
  ChangeProposalWarning,
  ChangeRuleState,
  EvidenceSource,
  GateActionRefusal,
  KnowledgeDeltaPreview,
  KnowledgeDeltaWarning,
  PhaseArtifact,
  PhaseRealizationRef,
  PhaseReview,
  PreviewClaim,
  PreviewEvidence,
  PreviewJustification,
  PreviewRevision,
  RuleVerificationPreview,
  RuleVerificationPreviewEntry,
  VerificationEvidence,
} from "../types";
import { loadError } from "../live/loadError";

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
 *
 * It opens wide (`size="lg"`) because what it shows is mostly a document — a
 * report, a changelog, a set of proposed rules — and a document squeezed into a
 * sidebar's measure is one nobody reads to the end before approving it.
 */

export interface GateSelection {
  instanceId: string;
  phaseId: string;
  pipelineName: string;
  /** Viewport Y of the opener, so the drawer grows from that row. */
  originY?: number;
}

/** A section of the review: an eyebrow, an optional aside, the content. */
function Block({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="eyebrow">{title}</h3>
        {aside && <div className="text-caption text-ink-faint">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** A heading inside a section — one rung below the eyebrow — with its count. */
function GroupHeading({ label, count }: { label: string; count?: number }) {
  return (
    <h4 className="flex items-center gap-2 text-small font-semibold text-ink-dim">
      {label}
      {count !== undefined && (
        <span className="text-caption font-normal tabular-nums text-ink-faint">{count}</span>
      )}
    </h4>
  );
}

/** Rows of like things share one inset well rather than a box each. */
const WELL = "overflow-hidden rounded-tile border border-line bg-ground-2/60";
const ROWS = `divide-y divide-line ${WELL}`;
/** The machine-text well: raw JSON, a log, a plain-text artifact. */
const CODE =
  "overflow-auto rounded-tile border border-line bg-ground-2/60 p-3.5 font-mono text-caption leading-relaxed text-ink-dim";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
 * The agent's closing words, taken apart for display.
 *
 * A phase's payload is usually the whole event the runtime handed the Stop
 * hook — session id, transcript path, permission mode, background tasks — with
 * the agent's final message as one field among a dozen, plus the `reason`
 * and `failureClass` Argus attached. What a reviewer wants is the reason and
 * the note; the rest is diagnostic, so it folds behind a toggle and only
 * comes forward when there is no prose to show instead. A bare string is
 * treated as the note itself.
 *
 * The reason leads the drawer, inside the "waiting on you" / "what went wrong"
 * panel; the notes and the leftovers follow it.
 */
interface PayloadParts {
  reason: string | null;
  notes: Note[];
  /** Whatever is left to show raw, or `undefined` for nothing. */
  raw: unknown;
  /** The raw part is bookkeeping beside prose, so it starts folded. */
  folded: boolean;
}

/** One piece of the agent's own writing, named by where it came from. */
interface Note {
  label: string;
  source: string;
  /** The outcome its `ARGUS_OUTCOME` line reported, if it had one. */
  outcome: string | null;
}

/** The agent's protocol line comes off its prose and is shown as a chip
 *  instead; the payload itself is untouched. */
function toNote(label: string, text: string): Note {
  const { prose, outcome } = splitOutcome(text);
  return { label, source: prose, outcome };
}

function payloadParts(value: unknown): PayloadParts {
  const none: PayloadParts = { reason: null, notes: [], raw: undefined, folded: false };
  if (value == null) return none;
  if (typeof value === "string") return { ...none, notes: [toNote("Closing note", value)] };
  if (typeof value !== "object" || Array.isArray(value)) return { ...none, raw: value };
  const { prose, rest } = splitPayload(value as Record<string, unknown>);
  if (Object.keys(prose).length === 0) return { ...none, raw: value };
  // The reason as a sentence, and each note without whatever opening line
  // only tells it again: with the Failed pill, one error used to be told three
  // times. A note that opens with the reason in fuller words lends that line
  // to the lead, and goes when it had nothing else to say.
  let reason = reasonText(prose.reason);
  const notes: Note[] = [];
  for (const [label, text] of [
    ["Summary", prose.summary],
    ["Agent's last message", prose.last_assistant_message],
  ] as const) {
    if (!text) continue;
    const note = toNote(label, text);
    const told = tellOnce(reason, note.source);
    if (told.reason !== reason && /[`*_[<]/.test(told.reason)) {
      // A line with Markdown in it reads properly only in the note, which
      // keeps it; the lead gives up its shorter telling instead.
      reason = "";
      notes.push(note);
      continue;
    }
    reason = told.reason;
    if (told.message) notes.push({ ...note, source: told.message });
  }
  return {
    reason: reason || null,
    notes,
    raw: Object.keys(rest).length > 0 ? rest : undefined,
    folded: true,
  };
}

/**
 * Why the drawer is open, first and loudest: a gate waiting on a person reads
 * in the waiting colour, a failure in the failing one, and the reason the
 * agent gave sits inside that panel rather than below a heading of its own.
 */
function Lead({
  status,
  reason,
  spawn = false,
}: {
  status: PhaseReview["status"];
  reason: string | null;
  /** A spawn phase: waiting means its `children` pause, where tasks did not succeed. */
  spawn?: boolean;
}) {
  const gated = status === "awaiting-approval";
  // Spelled out rather than "not waiting, so failed": a state this drawer does
  // not know about must not be announced as a failure.
  const pill: DsStatus = gated ? "await" : status === "failed" ? "failed" : "idle";
  return (
    <div
      className={`rounded-tile border px-4 py-4 sm:px-5 ${
        gated ? "border-await/30 bg-await/[0.07]" : "border-fail/30 bg-fail/[0.07]"
      }`}
    >
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden="true"
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${
            gated ? "border-await/40 bg-await/12 text-await" : "border-fail/40 bg-fail/12 text-fail"
          }`}
        >
          <Icon name={gated ? "approve" : "x-circle"} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <h3 className="text-title font-semibold text-ink">
              {gated
                ? spawn
                  ? "Some tasks did not succeed"
                  : "Waiting on you"
                : "What went wrong"}
            </h3>
            <StatusPill status={pill} />
          </div>
          {gated && (
            <p className="mt-0.5 text-small text-ink-dim">
              {spawn
                ? "Nothing more starts until you decide."
                : "The pipeline is paused here until you decide."}
            </p>
          )}
          {reason && (
            <p
              data-testid="gate-reason"
              className={`mt-3 whitespace-pre-wrap break-words text-body ${
                gated ? "text-await-ink" : "text-fail-ink"
              }`}
            >
              {reason}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ClosingNote({ note }: { note: Note }) {
  return (
    <div data-testid="gate-closing-note" className={`${WELL} px-4 py-3.5 sm:px-5`}>
      {/* Whose words these are, and what the agent said of its own work — in
          its words, never as a verdict: a marker is not verification. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="eyebrow">{note.label}</span>
        {note.outcome && (
          <span className={chipClass("neutral")} title="The outcome the agent reported">
            Reported {note.outcome}
          </span>
        )}
      </div>
      <Markdown
        source={note.source}
        className="!text-small leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      />
    </div>
  );
}

function RawPayload({ value }: { value: unknown }) {
  return (
    <pre data-testid="gate-raw-payload" className={`max-h-[30vh] ${CODE}`}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** A disclosure in the drawer's own idiom: a chevron that turns, a quiet label. */
const SUMMARY =
  "inline-flex cursor-pointer list-none select-none items-center gap-1.5 rounded-control py-0.5 text-caption font-semibold text-ink-faint transition-colors duration-(--duration-quick) hover:text-ink-dim [&::-webkit-details-marker]:hidden";
const SUMMARY_CHEVRON =
  "transition-transform duration-(--duration-quick) ease-(--ease-out-expo) group-open:rotate-90";

function PayloadDetails({ parts }: { parts: PayloadParts }) {
  if (parts.raw === undefined) return null;
  if (!parts.folded) return <RawPayload value={parts.raw} />;
  return (
    <details className="group">
      <summary className={SUMMARY}>
        <Icon name="chevron-right" size={14} className={SUMMARY_CHEVRON} />
        Raw payload
      </summary>
      <div className="mt-2">
        <RawPayload value={parts.raw} />
      </div>
    </details>
  );
}

type Check = NonNullable<PhaseReview["verification"]>["checks"][number];

function checkCounts(checks: Check[]) {
  return {
    passed: checks.filter((c) => c.status === "passed").length,
    failed: checks.filter((c) => c.status === "failed").length,
    notEvaluated: checks.filter((c) => c.status === "not-evaluated").length,
    total: checks.length,
  };
}

/**
 * A check's outcome as a mark. Passed and failed are icons with an accessible
 * name; a check that could not be evaluated is an en dash in the same ring —
 * deliberately neither a tick nor a cross, because it is neither, and its row
 * says "(not evaluated)" in words.
 */
function CheckMark({ status }: { status: Check["status"] }) {
  if (status === "passed")
    return <Icon name="check-circle" size={17} label="Passed" className="text-ok" />;
  if (status === "failed")
    return <Icon name="x-circle" size={17} label="Failed" className="text-fail" />;
  if (status === "not-evaluated") {
    return (
      <span
        aria-hidden="true"
        className="flex h-[17px] w-[17px] shrink-0 items-center justify-center"
      >
        <span className="flex h-3 w-3 items-center justify-center rounded-full border border-ink-faint text-micro leading-none text-ink-faint">
          –
        </span>
      </span>
    );
  }
  return <Icon name="clock" size={17} label="Running" className="text-ink-faint" />;
}

function Verification({ report }: { report: NonNullable<PhaseReview["verification"]> }) {
  return (
    <ul data-testid="gate-verification" className={ROWS}>
      {report.checks.map((c, i) => (
        <li
          key={i}
          className={`flex items-start gap-3 px-3.5 py-2.5 ${c.status === "failed" ? "bg-fail/[0.06]" : ""}`}
        >
          <span className="mt-px">
            <CheckMark status={c.status} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-words text-small text-ink">
              {c.label}
              {c.status === "not-evaluated" && (
                <span className="text-ink-faint"> (not evaluated)</span>
              )}
            </p>
            {c.detail && (
              <p
                className={`mt-0.5 break-words text-caption ${
                  c.status === "failed" ? "text-fail-ink" : "text-ink-faint"
                }`}
              >
                {c.detail}
              </p>
            )}
          </div>
        </li>
      ))}
      {report.checks.length === 0 && (
        <li className="px-3.5 py-3 text-small text-ink-faint">
          {report.status === "running" ? "Checks still running." : "No checks declared."}
        </li>
      )}
    </ul>
  );
}

function checksAside(checks: Check[]): string | null {
  const n = checkCounts(checks);
  if (n.total === 0) return null;
  return [
    n.passed > 0 && `${n.passed} passed`,
    n.failed > 0 && `${n.failed} failed`,
    n.notEvaluated > 0 && `${n.notEvaluated} not evaluated`,
  ]
    .filter(Boolean)
    .join(" · ");
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

/** A cited source. Paths, hashes and ids are machine text, so mono; a
 *  document's title and the person who said something are words, so they
 *  stay in the reading face. */
function SourceText({ source }: { source: EvidenceSource }) {
  if (source.type === "document") {
    return (
      <span className="text-ink-dim">
        {source.title && `${source.title} — `}
        <span className="break-all font-mono">{source.uri}</span>
      </span>
    );
  }
  if (source.type === "human") return <span className="text-ink-dim">{source.who}</span>;
  return <span className="break-all font-mono text-ink-dim">{describeSource(source)}</span>;
}

/** What kind of claim this is. A category, so a neutral chip: colour is kept
 *  for outcomes, which are statuses. */
/** A ledger value ("needs-input") as a label, for a value the glossary does
 *  not name. */
function asLabel(value: string): string {
  const words = value.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A claim's kind in the Knowledge view's words ("Business rule"), with its
 *  definition on hover, rather than the ledger's key ("business-rule"). */
function KindTag({ kind }: { kind: string }) {
  const term = KIND_TERMS[kind as keyof typeof KIND_TERMS];
  return (
    <span className={chipClass()} title={term?.definition}>
      {term?.term ?? asLabel(kind)}
    </span>
  );
}

/** An id or a ref beside a chip: machine text, so mono, and quiet. */
function Ref({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="min-w-0 break-all font-mono text-caption text-ink-faint" title={title}>
      {children}
    </span>
  );
}

/** A row's head: its chips and refs on one wrapping line. */
function RowHead({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{children}</div>;
}

const STATEMENT = "mt-1.5 break-words text-small leading-relaxed text-ink";

function EvidenceList({ evidence }: { evidence: PreviewEvidence[] }) {
  if (evidence.length === 0) {
    return (
      // Nothing failed: a claim without support is something a person should
      // weigh, so it reads in the waiting colour, like the warning about it.
      <p
        className="mt-1.5 flex items-center gap-1.5 text-caption text-await-ink"
        data-testid="candidate-no-evidence"
      >
        <Icon name="alert" size={13} className="text-await" />
        No evidence attached.
      </p>
    );
  }
  return (
    <ul className="mt-2 flex flex-col gap-1" aria-label="Evidence">
      {evidence.map((e, i) => (
        <li key={i} className="flex min-w-0 items-start gap-2 text-caption">
          {e.direction === "opposes" ? (
            <Icon name="x-circle" size={13} label="Opposes" className="mt-px text-fail" />
          ) : (
            <Icon name="arrow-right" size={13} className="mt-px text-ink-faint" />
          )}
          <span className="min-w-0 break-words">
            <SourceText source={e.source} />
            {e.note && <span className="text-ink-faint"> — {e.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function JustificationList({ justifications }: { justifications: PreviewJustification[] }) {
  if (justifications.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-col gap-0.5" aria-label="Justifications">
      {justifications.map((j, i) => (
        <li key={i} className="min-w-0 break-words text-caption text-ink-faint">
          {j.direction === "opposes" ? "Opposed by" : "From"}{" "}
          {j.premises.map((p, k) => (
            <Fragment key={k}>
              {k > 0 && " + "}
              <span className="break-all font-mono">{p.display}</span>
            </Fragment>
          ))}
          {j.note ? ` — ${j.note}` : ""}
        </li>
      ))}
    </ul>
  );
}

function CandidateClaim({ claim }: { claim: PreviewClaim }) {
  return (
    <li className="px-3.5 py-3">
      <RowHead>
        <KindTag kind={claim.kind} />
        <Ref>{claim.ref.display}</Ref>
      </RowHead>
      <p className={STATEMENT}>{claim.statement}</p>
      <EvidenceList evidence={claim.evidence} />
      <JustificationList justifications={claim.justifications} />
    </li>
  );
}

function CandidateRevision({ revision }: { revision: PreviewRevision }) {
  return (
    <li className="px-3.5 py-3">
      <RowHead>
        {revision.kind && <KindTag kind={revision.kind} />}
        <Ref>
          {revision.claimId} v{revision.expectedRevision} → v{revision.expectedRevision + 1}
        </Ref>
        {revision.stale && (
          <span
            className={chipClass("fail")}
            title="The ledger has moved past the revision this expects, so the commit will refuse it."
          >
            Stale
          </span>
        )}
      </RowHead>
      {revision.current && (
        <p className="mt-1.5 break-words text-small leading-relaxed text-ink-faint line-through decoration-ink-faint/60">
          {revision.current.statement}
        </p>
      )}
      <p
        className={
          revision.current ? "mt-0.5 break-words text-small leading-relaxed text-ink" : STATEMENT
        }
      >
        {revision.statement}
      </p>
      {revision.revisionNote && (
        <p className="mt-1 text-caption text-ink-faint">{revision.revisionNote}</p>
      )}
      <EvidenceList evidence={revision.evidence} />
      <JustificationList justifications={revision.justifications} />
    </li>
  );
}

/**
 * A warning as the drawer says it. The server writes them as clauses opening
 * on a ledger word ("assumption \"…\" carries neither…"), the one lower-case
 * line in the panel: the opening word is set in sentence case, and a claim
 * kind in the Knowledge view's words. One that opens on an id or a path
 * ("local:x", "RULE-17") is machine text and stays exactly as written.
 */
function warningText(message: string): string {
  const m = /^([a-z][a-z-]*)(\s[\s\S]*)$/.exec(message);
  if (!m) return message;
  const kind = KIND_TERMS[m[1] as keyof typeof KIND_TERMS] as
    (typeof KIND_TERMS)[keyof typeof KIND_TERMS] | undefined;
  return (kind?.term ?? sentenceStart(m[1])) + m[2];
}

/** Things Argus already knows are questionable, in the colour of "a person
 *  should look at this". */
function WarningList({ messages, testId }: { messages: string[]; testId: string }) {
  if (messages.length === 0) return null;
  return (
    <ul data-testid={testId} className="flex flex-col gap-1.5" aria-label="Warnings">
      {messages.map((m, i) => (
        <li
          key={i}
          className="flex min-w-0 items-start gap-2 rounded-control border border-await/25 bg-await/[0.06] px-3 py-2 text-small text-await-ink"
        >
          <Icon name="alert" size={15} className="mt-0.5 text-await" />
          <span className="min-w-0 break-words">{warningText(m)}</span>
        </li>
      ))}
    </ul>
  );
}

function Warnings({ warnings }: { warnings: KnowledgeDeltaWarning[] }) {
  return <WarningList testId="candidate-warnings" messages={warnings.map((w) => w.message)} />;
}

/** A missing outcome, or a missing set of criteria: something the agent was
 *  meant to submit and did not. Nothing has failed yet — a person has to
 *  decide whether the gap matters — so it reads in the waiting colour. */
function Missing({ testId, children }: { testId?: string; children: ReactNode }) {
  return (
    <p data-testid={testId} className="flex items-start gap-2 text-small text-await-ink">
      <Icon name="alert" size={15} className="mt-0.5 text-await" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** The one-sentence summary that opens each structured panel. */
const LEDE = "text-small leading-relaxed text-ink-dim";

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
    <div data-testid="gate-candidate-knowledge" className="flex flex-col gap-3">
      <p className={LEDE}>
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
        <ul className={ROWS} aria-label="Proposed revisions">
          {revisions.map((r, i) => (
            <CandidateRevision key={`${r.claimId}-${i}`} revision={r} />
          ))}
        </ul>
      )}
      {claims.length > 0 && (
        <ul className={ROWS} aria-label="Proposed claims">
          {claims.map((c, i) => (
            <CandidateClaim key={`${c.ref.display}-${i}`} claim={c} />
          ))}
        </ul>
      )}
      {consumed.length > 0 && (
        <p className="break-words text-caption text-ink-faint">
          Consumed: <span className="font-mono">{consumed.map((c) => c.ref).join(", ")}</span>
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

/** Outcomes *are* statuses, so they carry status colour: holding is done,
 *  violated is failing, and unverifiable is a question only a person can
 *  settle. */
const OUTCOME_TONE: Record<string, Parameters<typeof chipClass>[0]> = {
  holds: "ok",
  satisfied: "ok",
  violated: "fail",
  unverifiable: "await",
};

function OutcomeTag({ outcome }: { outcome: string }) {
  const term = TERMS[outcome as TermId] as (typeof TERMS)[TermId] | undefined;
  return (
    <span className={chipClass(OUTCOME_TONE[outcome] ?? "neutral")} title={term?.definition}>
      {term?.term ?? asLabel(outcome)}
    </span>
  );
}

function VerificationEvidenceList({ evidence }: { evidence: VerificationEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1" aria-label="Conformance evidence">
      {evidence.map((e, i) => {
        // A tick is earned by a check Argus saw pass; a cited file or an
        // observation is a pointer, not a verdict, so it gets an arrow.
        const failed = e.type === "check" && e.status === "failed";
        const passed = e.type === "check" && e.status === "passed";
        return (
          <li key={i} className="flex min-w-0 items-start gap-2 text-caption">
            {failed ? (
              <Icon name="x-circle" size={13} label="Failed" className="mt-px text-fail" />
            ) : passed ? (
              <Icon name="check" size={13} label="Passed" className="mt-px text-ok" />
            ) : (
              <Icon name="arrow-right" size={13} className="mt-px text-ink-faint" />
            )}
            <span className="min-w-0 break-words">
              {/* An observation is the verifier's own sentence, not machine text. */}
              <span
                className={
                  e.type === "observation" ? "text-ink-dim" : "break-all font-mono text-ink-dim"
                }
              >
                {describeVerificationEvidence(e)}
              </span>
              {"note" in e && e.note && e.type !== "observation" && (
                <span className="text-ink-faint"> — {e.note}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One axis of a rule's state, in words: "Rule supported", "Implementation
 * violated". The ledger's `rule: supported` and `impl: violated` sat in mono
 * beside chips that had already been put into words. The two axes stay side
 * by side and separately named, because reading them as one is the mistake
 * this panel exists to prevent.
 */
function RuleState({
  axis,
  value,
  title,
  tone = "text-ink-faint",
  children,
}: {
  axis: "Rule" | "Implementation";
  value: string;
  title: string;
  tone?: string;
  children?: ReactNode;
}) {
  const term = TERMS[value as TermId] as (typeof TERMS)[TermId] | undefined;
  return (
    <span className={`text-caption ${tone}`} title={title}>
      {axis} {(term?.term ?? asLabel(value)).toLowerCase()}
      {children}
    </span>
  );
}

function VerificationRow({ entry }: { entry: RuleVerificationPreviewEntry }) {
  return (
    <li className="px-3.5 py-3">
      <RowHead>
        <OutcomeTag outcome={entry.outcome} />
        <Ref>{entry.ref}</Ref>
        {entry.support && (
          <RuleState
            axis="Rule"
            value={entry.support}
            title="The rule's own support. Independent of whether the code conforms."
          />
        )}
      </RowHead>
      {entry.statement && <p className={STATEMENT}>{entry.statement}</p>}
      {entry.reason && <p className="mt-1 text-caption text-await">{entry.reason}</p>}
      {entry.note && <p className="mt-1 text-caption text-ink-faint">{entry.note}</p>}
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
    <div className="flex flex-col gap-2">
      <GroupHeading label={label} count={entries.length} />
      <ul className={ROWS} aria-label={label}>
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
    <div data-testid="gate-rule-verification" className="flex flex-col gap-4">
      <p className={LEDE}>
        {`${summary?.holds ?? holds.length} holds · ${summary?.violated ?? violated.length} violated · ${
          summary?.unverifiable ?? unverifiable.length
        } unverifiable`}
        {head?.gitHead ? ` · at ${head.gitHead.slice(0, 8)}` : ""}.{" "}
        {canApprove
          ? "Nothing here is durable yet; approving records it against these exact rule revisions."
          : "None of this became durable: the phase did not reach its commit."}
      </p>
      {missing.length > 0 && (
        <Missing testId="gate-verification-missing">
          No outcome submitted for {missing.join(", ")}.
        </Missing>
      )}
      <VerificationGroup label="Violated" entries={violated} />
      <VerificationGroup label="Unverifiable" entries={unverifiable} />
      <VerificationGroup label="Holds" entries={holds} />
      {previews.some((p) => p.summary) && (
        <p className="text-caption text-ink-faint">
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
 * Which accepted change this phase attempt is realizing, and which attempt it
 * is (Phase 8).
 *
 * Small on purpose. The decision a reviewer makes at a realization's gate is
 * the same one they always make — are these results right? — but they need one
 * thing the rest of the drawer cannot tell them: whether they are looking at
 * the first implementation or at a targeted remediation of it, and how many
 * attempts the author allowed. A remediation's results are not the first
 * attempt's, and approving them is not the same decision.
 */
function RealizationHeader({ realization }: { realization: PhaseRealizationRef }) {
  return (
    <p data-testid="gate-realization" className={LEDE}>
      Realizing <span className="font-mono text-ink">{realization.proposalId}</span> ·{" "}
      <span className="font-mono text-ink">{realization.id}</span> · {realization.kind} attempt{" "}
      {realization.attempt} of {realization.maxAttempts}.{" "}
      {realization.repository?.gitHead
        ? `The implementation left ${realization.repository.gitHead.slice(0, 8)}${
            realization.repository.workingTree
              ? ` with ${realization.repository.workingTree.dirty} uncommitted file${
                  realization.repository.workingTree.dirty === 1 ? "" : "s"
                }`
              : " clean"
          }.`
        : ""}
    </p>
  );
}

/**
 * Acceptance verification — the review surface for a staged set of
 * acceptance-criterion results (Phase 8).
 *
 * Rendered **beside** the business-rule panel and never merged into it,
 * because the two answer different questions and a reviewer has to be able to
 * see the state that matters most:
 *
 *   every rule holds   ·   AC-3 violated   →   the change is NOT complete
 *
 * A reviewer who could see only one dimension would eventually approve exactly
 * that. So each row names the criterion, its own statement, the exact
 * revisions it is evidence for, and the evidence the verifier cited — with a
 * cited check shown as Argus observed it, never as the agent described it.
 */
function AcceptanceRow({ entry }: { entry: AcceptanceVerificationPreviewEntry }) {
  return (
    <li className="px-3.5 py-3">
      <RowHead>
        <OutcomeTag outcome={entry.outcome} />
        <Ref>{entry.ref}</Ref>
        <KindTag kind={entry.kind} />
        {entry.relatesTo.length > 0 && (
          <Ref title="The exact revisions this criterion is evidence for.">
            {entry.relatesTo
              .map((r: { id: string; revision: number }) => `${r.id}:v${r.revision}`)
              .join(", ")}
          </Ref>
        )}
      </RowHead>
      <p className={STATEMENT}>{entry.statement}</p>
      {entry.reason && <p className="mt-1 text-caption text-await">{entry.reason}</p>}
      {entry.note && <p className="mt-1 text-caption text-ink-faint">{entry.note}</p>}
      <VerificationEvidenceList evidence={entry.evidence} />
    </li>
  );
}

function AcceptanceGroup({
  label,
  entries,
}: {
  label: string;
  entries: AcceptanceVerificationPreviewEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <GroupHeading label={label} count={entries.length} />
      <ul className={ROWS} aria-label={label}>
        {entries.map((e) => (
          <AcceptanceRow key={`${e.ref}-${e.outcome}`} entry={e} />
        ))}
      </ul>
    </div>
  );
}

function AcceptanceVerification({
  previews,
  summary,
  canApprove,
}: {
  previews: AcceptanceVerificationPreview[];
  summary: PhaseReview["acceptanceVerification"];
  canApprove: boolean;
}) {
  const satisfied = previews.flatMap((p) => p.satisfied);
  const violated = previews.flatMap((p) => p.violated);
  const unverifiable = previews.flatMap((p) => p.unverifiable);
  const missing = previews.flatMap((p) => p.missing);
  const state = previews.find((p) => p.repository)?.repository;
  const proposalId = summary?.proposalId ?? previews[0]?.proposalId;
  return (
    <div data-testid="gate-acceptance-verification" className="flex flex-col gap-4">
      <p className={LEDE}>
        {`${summary?.satisfied ?? satisfied.length} satisfied · ${
          summary?.violated ?? violated.length
        } violated · ${summary?.unverifiable ?? unverifiable.length} unverifiable`}
        {proposalId ? ` · for ${proposalId}` : ""}
        {state?.gitHead ? ` · at ${state.gitHead.slice(0, 8)}` : ""}
        {state?.workingTree ? ` (+${state.workingTree.dirty} uncommitted)` : ""}.{" "}
        {canApprove
          ? "Nothing here is durable yet; approving records it against this exact implementation."
          : "None of this became durable: the phase did not reach its commit."}
      </p>
      {missing.length > 0 && (
        <Missing testId="gate-acceptance-missing">
          No outcome submitted for {missing.join(", ")}.
        </Missing>
      )}
      <AcceptanceGroup label="Violated" entries={violated} />
      <AcceptanceGroup label="Unverifiable" entries={unverifiable} />
      <AcceptanceGroup label="Satisfied" entries={satisfied} />
      {previews.some((p) => p.summary) && (
        <p className="text-caption text-ink-faint">
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
      className={chipClass(ready ? "ok" : "await")}
      title={
        ready
          ? "Every relevant rule is accounted for and nothing is unresolved."
          : "Unresolved questions or uncovered rule changes: this proposal cannot drive an implementation."
      }
    >
      {asLabel(readiness)}
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
    <li className="px-3.5 py-3">
      <RowHead>
        <KindTag kind={rule.kind} />
        <Ref>{rule.ref}</Ref>
        <RuleState axis="Rule" value={rule.support} title="The rule's own support." />
        <RuleState
          axis="Implementation"
          value={rule.conformance}
          tone={CONFORMANCE_TONE[rule.conformance]}
          title="What the implementation does. Independent of whether the rule is well founded."
        >
          {rule.conformanceAt && (
            <>
              {" at "}
              <span className="font-mono">{rule.conformanceAt.slice(0, 8)}</span>
            </>
          )}
        </RuleState>
      </RowHead>
      <p className={STATEMENT}>{rule.statement}</p>
    </li>
  );
}

function ChangeWarnings({ warnings }: { warnings: ChangeProposalWarning[] }) {
  return <WarningList testId="change-warnings" messages={warnings.map((w) => w.message)} />;
}

function AcceptanceCriteria({ criteria }: { criteria: AcceptanceCriterion[] }) {
  if (criteria.length === 0) return null;
  return (
    <ol data-testid="change-acceptance-criteria" className={ROWS} aria-label="Acceptance criteria">
      {criteria.map((c) => (
        <li
          key={c.id}
          className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1 px-3.5 py-2.5"
        >
          <span className="shrink-0 whitespace-nowrap font-mono text-caption text-ink-faint">
            {c.id}
          </span>
          <KindTag kind={c.kind} />
          <span className="min-w-0 basis-full break-words text-small text-ink sm:basis-0 sm:flex-1">
            {c.statement}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One labelled part of a change proposal: Current, Proposed, Preserved… */
function Part({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <GroupHeading label={label} count={count} />
      {children}
    </div>
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
    <div data-testid="gate-change-proposal" className="flex flex-col gap-6">
      {previews.map((p) => {
        const revisions = p.semantic?.proposedRevisions ?? [];
        const claims = p.semantic?.proposedClaims ?? [];
        const decisions = claims.filter((c) => c.kind === "decision");
        const others = claims.filter((c) => c.kind !== "decision");
        return (
          <div key={p.proposalId} className="flex flex-col gap-4">
            <div className={`${WELL} px-4 py-3.5`}>
              <RowHead>
                <ReadinessTag readiness={p.readiness} />
                <Ref>{p.request.id}</Ref>
              </RowHead>
              <p
                data-testid="change-request"
                className="mt-2 break-words text-body leading-relaxed text-ink"
              >
                {p.request.summary}
              </p>
              {p.request.details && (
                <p className="mt-1 break-words text-small leading-relaxed text-ink-dim">
                  {p.request.details}
                </p>
              )}
            </div>
            <p className={LEDE}>
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
              <Part label="Current" count={p.current.length}>
                <ul className={ROWS} aria-label="Current rules">
                  {p.current.map((r) => (
                    <CurrentRule key={r.ref} rule={r} />
                  ))}
                </ul>
              </Part>
            )}

            {(revisions.length > 0 || others.length > 0) && (
              <Part label="Proposed" count={revisions.length + others.length}>
                {revisions.length > 0 && (
                  <ul className={ROWS} aria-label="Proposed revisions">
                    {revisions.map((r, i) => (
                      <CandidateRevision key={`${r.claimId}-${i}`} revision={r} />
                    ))}
                  </ul>
                )}
                {others.length > 0 && (
                  <ul className={ROWS} aria-label="Proposed claims">
                    {others.map((c, i) => (
                      <CandidateClaim key={`${c.ref.display}-${i}`} claim={c} />
                    ))}
                  </ul>
                )}
              </Part>
            )}

            {p.preserved.length > 0 && (
              <Part label="Preserved" count={p.preserved.length}>
                <ul data-testid="change-preserved" className={ROWS}>
                  {p.preserved.map((c) => (
                    <li key={c.ref} className="flex min-w-0 items-start gap-2.5 px-3.5 py-2.5">
                      <Icon name="check" size={14} className="mt-0.5 text-ok" />
                      <span className="min-w-0 break-words text-small text-ink-dim">
                        <span className="whitespace-nowrap font-mono text-caption text-ink-faint">
                          {c.ref}
                        </span>{" "}
                        {c.statement}
                      </span>
                    </li>
                  ))}
                </ul>
              </Part>
            )}

            {decisions.length > 0 && (
              <Part label="Decisions" count={decisions.length}>
                <ul className={ROWS} aria-label="Decisions">
                  {decisions.map((c, i) => (
                    <CandidateClaim key={`${c.ref.display}-${i}`} claim={c} />
                  ))}
                </ul>
              </Part>
            )}

            <Part label="Acceptance criteria" count={p.acceptanceCriteria.length}>
              {p.acceptanceCriteria.length === 0 ? (
                <Missing>
                  None. There is no observable way to judge whether this change was implemented.
                </Missing>
              ) : (
                <AcceptanceCriteria criteria={p.acceptanceCriteria} />
              )}
            </Part>

            <Part label="Unresolved" count={p.unresolved.length}>
              {p.unresolved.length === 0 ? (
                <p data-testid="change-unresolved-none" className="text-small text-ink-faint">
                  None
                </p>
              ) : (
                <ul data-testid="change-unresolved" className={ROWS}>
                  {p.unresolved.map((q) => (
                    <li
                      key={q.id}
                      className="flex min-w-0 items-baseline gap-2.5 px-3.5 py-2.5 text-small"
                    >
                      {/* Whole: an id that may shrink broke "Q-1" over two lines. */}
                      <span className="shrink-0 whitespace-nowrap font-mono text-caption text-ink-faint">
                        {q.id}
                      </span>
                      <span className="min-w-0 break-words text-await-ink">{q.question}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Part>

            {p.summary && <p className="text-caption text-ink-faint">{p.summary}</p>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A path with its directory receding. A narrow row squeezes the directory
 * first, down to a few characters and an ellipsis, then the file's stem; the
 * extension stays, so a clipped name still says what kind of file it is.
 * `wrap` breaks it over lines instead, where there is room to show it whole.
 */
function PathLabel({ path, wrap = false }: { path: string; wrap?: boolean }) {
  const cut = path.lastIndexOf("/");
  const dir = cut >= 0 ? path.slice(0, cut + 1) : "";
  const base = cut >= 0 ? path.slice(cut + 1) : path;
  if (wrap) {
    return (
      <span className="min-w-0 flex-1 break-words font-mono text-small">
        {dir && <span className="text-ink-faint">{dir}</span>}
        {base}
      </span>
    );
  }
  const dot = base.lastIndexOf(".");
  const split = dot > 0 && base.length - dot <= 8;
  const stem = split ? base.slice(0, dot) : base;
  const ext = split ? base.slice(dot) : "";
  // Mono, so widths are counted in characters against the row's own width
  // (100cqw) and rounded down to whole ones: an ellipsis then sits flush
  // against what follows it instead of leaving a stray part-character gap,
  // which flex shrinking alone would.
  const fit = (w: string) => `calc(round(down, ${w}, 1ch) + 0.5px)`;
  const dirWidth = dir
    ? fit(`clamp(${Math.min(dir.length, 6)}ch, 100cqw - ${base.length}ch, ${dir.length}ch)`)
    : "0px";
  const stemWidth = fit(`min(${stem.length}ch, 100cqw - ${dirWidth} - ${ext.length}ch - 0.5px)`);
  return (
    <span className="flex min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono text-small [container-type:inline-size]">
      {dir && (
        <span className="shrink-0 truncate text-ink-faint" style={{ width: dirWidth }}>
          {dir}
        </span>
      )}
      <span className="shrink-0 truncate" style={{ width: stemWidth }}>
        {stem}
      </span>
      {ext && <span className="shrink-0">{ext}</span>}
    </span>
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
    <ul aria-label="Artifacts" className={`flex flex-col gap-px p-1 ${WELL}`}>
      {artifacts.map((a) => {
        const active = a.path === selected;
        return (
          <li key={a.path}>
            <button
              type="button"
              onClick={() => onSelect(a.path)}
              aria-current={active ? "true" : undefined}
              title={a.path}
              className={`flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left transition-colors duration-(--duration-quick) ${
                active
                  ? "bg-surface-2 text-ink"
                  : "text-ink-dim hover:bg-surface-2/60 hover:text-ink"
              }`}
            >
              <Icon name="file" size={15} className={active ? "text-eye" : "text-ink-faint"} />
              <PathLabel path={a.path} />
              {a.required && <span className={chipClass()}>Required</span>}
              {!a.text && <span className={chipClass()}>Binary</span>}
              <span className="w-16 shrink-0 text-right text-caption text-ink-faint">
                {formatBytes(a.bytes)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The selected file, in a reading panel: its name and size on a header strip,
 *  then the document itself. A lone file is already named by the one row
 *  above it, so its strip carries only the size and age. */
function ArtifactViewer({
  selection,
  path,
  single,
}: {
  selection: GateSelection;
  path: string;
  single: boolean;
}) {
  const { content, loading, error } = useArtifactContent(
    selection.instanceId,
    selection.phaseId,
    path,
  );
  if (!loading && !error && !content) return null;
  const header = (!single || content) && (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line px-4 py-2.5">
      {!single && (
        // A floor on the path's width, so on a phone the size and age drop to
        // their own line instead of squeezing the name into a column.
        <span className="flex min-w-48 flex-1 items-start gap-2 text-ink" title={path}>
          <Icon name="file" size={15} className="mt-0.5 shrink-0 text-ink-faint" />
          <PathLabel path={path} wrap />
        </span>
      )}
      {content && (
        <span className="text-caption text-ink-faint">
          {formatBytes(content.bytes)} · modified <TimeAgo iso={content.modifiedAt} />
        </span>
      )}
    </div>
  );
  let body: ReactNode;
  if (loading) {
    body = (
      <div role="status" aria-busy="true" className="px-5 py-4">
        <span className="sr-only">Loading {path}…</span>
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-4/5" />
        <Skeleton className="mt-2 h-3 w-2/3" />
      </div>
    );
  } else if (error) {
    body = (
      <p role="alert" className="flex items-start gap-2 px-4 py-3.5 text-small text-fail">
        <Icon name="alert" size={15} className="mt-0.5" />
        <span className="min-w-0 break-words">{loadError(path, error)}</span>
      </p>
    );
  } else if (content && !content.text) {
    body = (
      <p className="flex items-center gap-2 px-4 py-6 text-small text-ink-dim">
        <Icon name="eye" size={15} className="text-ink-faint" />
        Binary — not shown here.
      </p>
    );
  } else {
    const text = content?.content ?? "";
    body = (
      <Fragment>
        {content?.truncated && (
          <p className="flex items-center gap-2 border-b border-line px-4 py-2 text-caption text-ink-faint">
            <Icon name="info" size={13} />
            Showing the first {formatBytes(text.length)} of {formatBytes(content.bytes)}.
          </p>
        )}
        {isMarkdown(path) ? (
          <div className="px-5 py-4 sm:px-6 sm:py-5">
            <Markdown source={text} className="!text-body max-w-[75ch] leading-relaxed" />
          </div>
        ) : (
          <pre
            data-testid="artifact-raw"
            className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-caption leading-relaxed text-ink-dim"
          >
            {text}
          </pre>
        )}
      </Fragment>
    );
  }
  return (
    <div data-testid="artifact-viewer" className={WELL}>
      {header}
      {body}
    </div>
  );
}

interface GateActions {
  approve: (instanceId: string, opts?: GateActionOptions) => Promise<unknown>;
  revise: (instanceId: string, note?: string, opts?: GateActionOptions) => Promise<unknown>;
  /** Stop the instance. Offered only at a spawn phase's `children` pause, and
   *  at a child's gate its parent no longer waits for (`parent-decided`). */
  abort?: (instanceId: string) => Promise<unknown>;
}

/** What the refusals a client acts on mean here, ahead of the server's own words. */
const REFUSAL: Record<GateActionRefusal, string> = {
  "parent-decided": "Its parent no longer waits for this task.",
  "answers-not-accepted": "This pause takes no answers.",
  "children-running": "A task you re-ran is running again.",
};

function refusalOf(e: unknown): GateActionRefusal | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code in REFUSAL ? (code as GateActionRefusal) : null;
}

export function GateDrawer({
  selection,
  onClose,
  approve,
  revise,
  abort,
  onOpen,
  board = [],
}: GateActions & {
  selection: GateSelection | null;
  onClose: () => void;
  /** Open another gate in this drawer: a task's child, from a spawn phase's review. */
  onOpen?: (selection: GateSelection) => void;
  /** The board's rows, to name a spawn phase's child pipeline and find its children. */
  board?: OverviewRow[];
}) {
  const { review, loading, error } = useGateReview(
    selection?.instanceId ?? null,
    selection?.phaseId ?? null,
  );
  if (!selection) return <Drawer open={false} title="" onClose={onClose} children={null} />;
  // The hook keeps the last gate's review while the next one loads, and it
  // must not be shown, nor approved, under this gate's title.
  const current =
    review?.instanceId === selection.instanceId && review.phaseId === selection.phaseId
      ? review
      : null;
  // Fresh state per gate: a different phase must not inherit a half-typed note
  // or a stale "approved" line, so the panel is keyed on the gate and remounts.
  // Not on the attempt: that is unknown until the review arrives, and keying on
  // it remounted the drawer the moment it did, which replayed its entrance and
  // lost track of the button that opened it. A new attempt resets in place.
  return (
    <GatePanel
      key={`${selection.instanceId}/${selection.phaseId}`}
      selection={selection}
      review={current}
      loading={loading || (!current && !error)}
      error={error}
      onClose={onClose}
      approve={approve}
      revise={revise}
      abort={abort}
      onOpen={onOpen}
      board={board}
    />
  );
}

/** Argus's own checks, summarised beside the buttons that act on them. */
function ChecksSummary({ checks }: { checks: Check[] }) {
  const n = checkCounts(checks);
  if (n.total === 0) return null;
  if (n.failed > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-fail">
        <Icon name="x-circle" size={14} />
        {plural(n.failed, "check")} failed
      </span>
    );
  }
  // A check that was not evaluated has not failed, so a partial result is a
  // plain breakdown rather than a near-miss "2 of 3".
  if (n.passed < n.total) {
    return <span className="text-caption text-ink-dim">{checksAside(checks)}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-ok">
      <Icon name="check-circle" size={14} />
      {n.total === 1 ? "1 check passed" : `All ${n.total} checks passed`}
    </span>
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
  abort,
  onOpen,
  board,
}: GateActions & {
  selection: GateSelection;
  review: PhaseReview | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onOpen?: (selection: GateSelection) => void;
  board: OverviewRow[];
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Which refusal the last action met, when it was one a client acts on.
  const [refusal, setRefusal] = useState<GateActionRefusal | null>(null);
  // A decision here was refused because the parent moved on. Kept past the
  // next action, so a Stop that fails stays on offer to try again.
  const [parentDecided, setParentDecided] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const confirm = useConfirm();
  // The same gate on a new attempt (it was revised and stopped here again)
  // starts clean. Reset during render, so no frame shows the last attempt's
  // note or its "Revision sent" line under the new attempt's files.
  const [attempt, setAttempt] = useState(review?.attempt);
  if (review && review.attempt !== attempt) {
    setAttempt(review.attempt);
    if (attempt !== undefined) {
      setSelectedPath(null);
      setBusy(false);
      setNoteOpen(false);
      setNote("");
      setErr(null);
      setRefusal(null);
      setParentDecided(false);
      setSent(null);
    }
  }
  const noteId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Opening the note is asking to write one: put the caret there.
  useEffect(() => {
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

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
    setRefusal(null);
    void action()
      .then(() => setSent(sentLabel))
      .catch((e: unknown) => {
        const code = refusalOf(e);
        setErr(e instanceof Error ? e.message : String(e));
        setRefusal(code);
        if (code === "parent-decided") setParentDecided(true);
        setBusy(false);
      });
  };

  const gated = review?.status === "awaiting-approval";
  const failed = review?.status === "failed";
  const retry = failed && (review?.payload as { kind?: string } | null)?.kind === "restarted";
  const spawn = review?.children;
  // A spawn phase is never gated, so waiting with children means its
  // `children` pause: a task did not succeed, and you decide what follows.
  const childrenPause = gated && spawn !== undefined;
  const reviseLabel = childrenPause ? "Re-run the rest" : retry ? "Retry" : "Revise";
  // Re-running the tasks that did not succeed needs no note: the usual reason
  // is a transient failure. One given reaches every re-run child.
  const noteRequired = gated && !childrenPause;
  // Stop is offered where stopping is one of the answers: at a `children`
  // pause, and at the gate of a child its parent has stopped waiting for. A
  // failed child has already ended, so there is nothing left to stop.
  const stoppable = abort && (childrenPause || (parentDecided && gated)) ? abort : null;
  const target: GateActionOptions = { phaseId: selection.phaseId };
  const canSend = !busy && !(noteRequired && note.trim() === "");
  const send = () =>
    run(
      () => revise(selection.instanceId, note.trim() || undefined, target),
      childrenPause
        ? "Re-run sent — tasks restarting"
        : retry
          ? "Retry sent — phase restarting"
          : "Revision sent — phase restarting",
    );
  // At a `children` pause the payload is the children summary, which the Tasks
  // block tells better; a failed spawn phase keeps its reason.
  const parts = payloadParts(childrenPause ? null : (review?.payload ?? null));
  const checks = review?.verification?.checks ?? [];

  return (
    <Drawer
      open
      size="lg"
      onClose={onClose}
      originY={selection.originY}
      title={review?.phaseName ?? selection.phaseId}
      subtitle={`${selection.pipelineName}${review ? ` · attempt ${review.attempt + 1}` : ""}`}
      footer={
        review && (
          <div className="flex flex-col gap-3">
            {noteOpen && (
              <div className="flex flex-col gap-2 border-b border-line pb-3">
                <label htmlFor={noteId} className={labelClass}>
                  {childrenPause ? "Note for the re-run tasks" : "Revision note"}
                  {!noteRequired && <span className="font-normal text-ink-faint"> (optional)</span>}
                </label>
                <p className="text-caption text-ink-faint">
                  {childrenPause
                    ? "Re-runs every task that did not succeed: a failed child runs its failed phase again with your note, and an aborted or unstarted task gets a new child. Tasks that succeeded are kept."
                    : retry
                      ? "Runs the phase again. A note is optional."
                      : "Sends it back to the agent with your note; this attempt's files are discarded and the phase runs again."}
                </p>
                <textarea
                  id={noteId}
                  ref={noteRef}
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      if (canSend) send();
                    }
                  }}
                  placeholder={noteRequired ? "What should change?" : "Note (optional)"}
                  className={`${fieldClass} min-h-20 w-full resize-y leading-relaxed`}
                />
                <div className="flex items-center justify-end gap-3">
                  <span className="hidden items-center gap-1 text-caption text-ink-faint sm:inline-flex">
                    <kbd className="kbd">Ctrl</kbd>
                    <kbd className="kbd">Enter</kbd>
                    <span className="ml-0.5">to send</span>
                  </span>
                  <Button
                    variant="primary"
                    size="lg"
                    iconRight="arrow-right"
                    disabled={!canSend}
                    onClick={send}
                  >
                    Send
                  </Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {/* One loud action at a time: while a note is being written, Send
                  is it, and Approve steps back (still there, no longer the
                  bigger target beside the action being composed). */}
              {review.canApprove && (
                <Button
                  variant={noteOpen ? "secondary" : "approve"}
                  size="lg"
                  icon="check"
                  disabled={busy}
                  className="flex-1 sm:flex-none"
                  onClick={() =>
                    run(
                      () => approve(selection.instanceId, target),
                      childrenPause
                        ? "Accepted — continuing without the rest"
                        : "Approved — pipeline resuming",
                    )
                  }
                >
                  {childrenPause ? "Accept the rest" : "Approve"}
                </Button>
              )}
              <Button
                // With no Approve on offer, sending it back is the next step.
                variant={!review.canApprove && !noteOpen ? "primary" : "secondary"}
                size="lg"
                icon={retry || childrenPause ? "retry" : "edit"}
                disabled={busy}
                aria-expanded={noteOpen}
                className="flex-1 aria-expanded:border-ink-faint/45 aria-expanded:bg-surface-3 sm:flex-none"
                onClick={() => setNoteOpen((o) => !o)}
              >
                {reviseLabel}
              </Button>
              {stoppable && (
                <Button
                  variant="danger"
                  size="lg"
                  icon="stop"
                  disabled={busy}
                  aria-expanded={confirm.armed === "stop"}
                  className="flex-1 sm:flex-none"
                  onClick={confirm.toggle("stop")}
                >
                  Stop
                </Button>
              )}
              <span className="ml-auto flex min-w-0 items-center">
                <ChecksSummary checks={checks} />
              </span>
            </div>
            {stoppable &&
              confirm.armed === "stop" &&
              confirm.question(
                {
                  title: `Stop this instance of “${review.pipelineName}”?`,
                  detail: childrenPause
                    ? "Nothing more starts and no later phase runs. Tasks that finished stay as they are."
                    : "Its parent no longer waits for it, so nothing it does from here counts.",
                  confirm: "Stop instance",
                  cancel: "Keep waiting",
                  icon: "stop",
                },
                () => run(() => stoppable(selection.instanceId), "Stopped"),
              )}
            {sent && !err ? (
              <p role="status" className="flex items-center gap-2 text-small font-semibold text-ok">
                <Icon name="check-circle" size={16} />
                {sent}
              </p>
            ) : (
              review.canApprove &&
              !noteOpen &&
              !err &&
              (childrenPause ? (
                // What accepting drops, said beside the button rather than
                // asked about: approving states what it continues with too.
                <p data-testid="spawn-dropped" className="text-caption text-ink-faint">
                  {`Accepting continues without ${keyList(spawn.notSucceeded)}.`}
                </p>
              ) : (
                <p className="text-caption text-ink-faint">
                  Approve continues the pipeline with exactly what is shown here.
                </p>
              ))
            )}
            {err && (
              <p role="alert" className="flex items-start gap-2 text-small text-fail">
                <Icon name="alert" size={16} className="mt-px" />
                <span className="min-w-0 break-words">
                  {refusal && (
                    <span className="font-semibold">
                      {`${REFUSAL[refusal]} `}
                      {refusal === "parent-decided" && failed && "Nothing is left to decide here. "}
                    </span>
                  )}
                  {err}
                </span>
              </p>
            )}
          </div>
        )
      }
    >
      {loading && !review ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">Loading the review…</span>
          <Skeleton className="h-24 w-full rounded-tile" />
          <div>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-4/5" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </div>
        </div>
      ) : error && !review ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-tile border border-fail/30 bg-fail/[0.07] px-4 py-3 text-small text-fail-ink"
        >
          <Icon name="alert" size={16} className="mt-0.5 text-fail" />
          <span className="min-w-0 break-words">{loadError("the review", error)}</span>
        </div>
      ) : review ? (
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            <Lead status={review.status} reason={parts.reason} spawn={spawn !== undefined} />
            {parts.notes.map((n, i) => (
              <ClosingNote key={i} note={n} />
            ))}
            {/* A spawn phase runs no agent, so there is no note to miss. */}
            {review.payload == null && !spawn && (
              <p className="text-small text-ink-faint">The agent left no closing note.</p>
            )}
            <PayloadDetails parts={parts} />
          </div>

          {spawn && (
            <Block title="Tasks" aside={countsLine(taskCounts(spawn.tasks))}>
              <SpawnTaskList
                rows={reviewTaskRows(spawn, board, childrenPause)}
                label={`Tasks of phase ${review.phaseName}`}
                onReview={
                  onOpen &&
                  ((row, originY) =>
                    row.gate &&
                    onOpen(
                      childSelection(
                        row.gate,
                        row.key,
                        childPipelineName(spawn.pipelineId, board),
                        originY,
                      ),
                    ))
                }
              />
            </Block>
          )}

          {review.verification && (
            <Block title="Checks" aside={checksAside(review.verification.checks)}>
              <Verification report={review.verification} />
            </Block>
          )}

          {review.result !== undefined && (
            <Block title="Result">
              <pre data-testid="gate-result" className={`max-h-[30vh] ${CODE}`}>
                {JSON.stringify(review.result, null, 2)}
              </pre>
            </Block>
          )}

          {review.knowledge && review.knowledge.length > 0 && (
            <Block title="Candidate knowledge">
              <CandidateKnowledge
                previews={review.knowledge}
                discovery={review.discovery}
                canApprove={review.canApprove}
              />
            </Block>
          )}

          {review.changeProposals && review.changeProposals.length > 0 && (
            <Block title="Change intent">
              <ChangeProposalPanel
                previews={review.changeProposals}
                summary={review.changeIntent}
                canApprove={review.canApprove}
              />
            </Block>
          )}

          {review.ruleVerifications && review.ruleVerifications.length > 0 && (
            <Block title="Business-rule verification">
              <RuleVerification
                previews={review.ruleVerifications}
                summary={review.ruleVerification}
                canApprove={review.canApprove}
              />
            </Block>
          )}

          {review.realization && (
            <Block title="Change realization">
              <RealizationHeader realization={review.realization} />
            </Block>
          )}

          {review.acceptanceVerifications && review.acceptanceVerifications.length > 0 && (
            <Block title="Acceptance criteria">
              <AcceptanceVerification
                previews={review.acceptanceVerifications}
                summary={review.acceptanceVerification}
                canApprove={review.canApprove}
              />
            </Block>
          )}

          {!(spawn && artifacts.length === 0) && (
            <Block
              title="Artifacts"
              aside={artifacts.length > 0 ? plural(artifacts.length, "file") : undefined}
            >
              {artifacts.length === 0 ? (
                <p data-testid="gate-no-artifacts" className="text-small text-ink-faint">
                  This phase left no files.
                  {review.canApprove ? " Approving continues with the summary above." : ""}
                </p>
              ) : (
                <Fragment>
                  {review.truncated && (
                    <p className="text-caption text-ink-faint">
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
                      single={artifacts.length === 1}
                    />
                  )}
                </Fragment>
              )}
            </Block>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
