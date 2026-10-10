import type { ReactNode } from "react";
import type { ClaimKind } from "@argus/contracts";
import { InfoTip } from "../../ds";
import { KIND_TERMS, TERMS, type TermId } from "../knowledgeGlossary";
import { KIND_GLYPH, type ExceptionTone } from "../knowledgeModel";

const TONE: Record<ExceptionTone, string> = {
  fail: "border-fail/45 bg-fail/10 text-fail",
  run: "border-run/45 bg-run/10 text-run",
  idle: "border-idle/45 bg-idle/10 text-ink-dim",
};

/** A kind's glyph. Shape carries kind; colour stays free for exceptions. */
export function KindMark({ kind, className = "" }: { kind: ClaimKind; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block w-4 text-center leading-none ${
        kind === "business-rule" ? "text-ink" : "text-ink-faint"
      } ${className}`}
    >
      {KIND_GLYPH[kind]}
    </span>
  );
}

/** The only coloured mark on a row, and only when something is off. */
export function ExceptionBadge({ term, tone }: { term: TermId; tone: ExceptionTone }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] ${TONE[tone]}`}
    >
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

/** Mono eyebrow heading with an optional explanation beside it. */
export function Eyebrow({ children, tip }: { children: ReactNode; tip?: ReactNode }) {
  return (
    <h3 className="mb-2.5 flex items-center gap-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
      {children}
      {tip}
    </h3>
  );
}
