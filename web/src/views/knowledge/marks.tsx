import type { ReactNode } from "react";
import type { ClaimKind } from "@argus/contracts";
import { Icon, type IconName } from "../../ds";
import { KIND_TERMS, TERMS, type TermId } from "../knowledgeGlossary";
import type { ExceptionTone } from "../knowledgeModel";
import { InfoTip } from "../../ds/InfoTip";

// The model calls the middle tone "run"; on screen it is violet, the colour of
// "a person should look at this". Amber means a run is working, and a stale or
// unsupported claim is not that.
const TONE: Record<ExceptionTone, string> = {
  fail: "border-fail/35 bg-fail/12 text-fail",
  run: "border-await/40 bg-await/10 text-await",
  idle: "border-line-strong bg-ink-faint/8 text-ink-dim",
};

/**
 * A kind's shape. Drawn rather than typed: the old ◆ ■ ● ○ ▲ ★ glyphs were set
 * in whatever fallback font the system found, at its size and baseline (and ★
 * could turn into an emoji). Shape carries kind; colour stays free for
 * exceptions.
 */
const KIND_ICON: Record<ClaimKind, IconName> = {
  "business-rule": "diamond",
  constraint: "square",
  fact: "circle-dot",
  assumption: "circle-dashed",
  conclusion: "triangle",
  decision: "star",
};

export function KindMark({
  kind,
  size = 14,
  className = "",
}: {
  kind: ClaimKind;
  size?: number;
  className?: string;
}) {
  return (
    <Icon
      name={KIND_ICON[kind]}
      size={size}
      strokeWidth={2}
      className={`${kind === "business-rule" ? "text-ink" : "text-ink-faint"} ${className}`}
    />
  );
}

/** The only coloured mark on a row, and only when something is off. Same
 *  anatomy as `StatusPill` at its small size. */
export function ExceptionBadge({ term, tone }: { term: TermId; tone: ExceptionTone }) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border pl-1.5 pr-2 text-micro font-semibold leading-none ${TONE[tone]}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {TERMS[term].term}
    </span>
  );
}

/** A glossary term as an inline explanation: the word itself opens its meaning. */
export function Term({
  id,
  children,
  align,
}: {
  id: TermId;
  children?: ReactNode;
  align?: "start" | "end";
}) {
  const t = TERMS[id];
  return (
    <InfoTip
      title={t.term}
      note={t.note}
      footer={`KNOWLEDGE-LEDGER.md ${t.docRef}`}
      trigger={children}
      align={align}
    >
      {t.definition}
    </InfoTip>
  );
}

export function KindTip({ kind }: { kind: ClaimKind }) {
  const t = KIND_TERMS[kind];
  return (
    <InfoTip title={t.term} footer={`KNOWLEDGE-LEDGER.md ${t.docRef}`}>
      {t.definition}
    </InfoTip>
  );
}

/** Section label with an optional explanation beside it. */
export function Eyebrow({ children, tip }: { children: ReactNode; tip?: ReactNode }) {
  return (
    <h3 className="eyebrow mb-2.5 flex items-center gap-2">
      {children}
      {tip}
    </h3>
  );
}
