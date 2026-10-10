import { Drawer } from "../../ds/Drawer";
import type { ReactNode } from "react";
import type { AtlasClaim, ClaimRef, KnowledgeAtlas } from "@argus/contracts";
import { TimeAgo } from "../../ds";
import { useClaimDetail } from "../../useClaimDetail";
import { KIND_TERMS, TERMS } from "../knowledgeGlossary";
import {
  describeSource,
  exceptionOf,
  moduleOf,
  plural,
  refKey,
  revisionsOf,
  scopeLabel,
  shortId,
  stripModule,
} from "../knowledgeModel";
import { ExceptionBadge, Eyebrow, KindMark, KindTip, Term } from "./marks";

/**
 * One claim, answered as four plain questions: what it says, why Argus
 * believes it, whether anyone checked, and who relied on it.
 */
export function ClaimDrawer({
  claim,
  atlas,
  originY,
  onClose,
  onSelect,
}: {
  claim: AtlasClaim | null;
  atlas: KnowledgeAtlas;
  originY?: number;
  onClose: () => void;
  onSelect: (ref: ClaimRef) => void;
}) {
  return (
    <Drawer
      open={claim !== null}
      originY={originY}
      onClose={onClose}
      title={
        claim ? (
          <span className="flex items-center gap-2">
            <KindMark kind={claim.kind} />
            {KIND_TERMS[claim.kind].term}
            <span className="font-mono text-ink-faint">{shortId(claim.id)}</span>
          </span>
        ) : (
          ""
        )
      }
      subtitle={
        claim ? <span className="font-mono">{`${claim.id}:v${claim.revision}`}</span> : undefined
      }
    >
      {claim && <ClaimBody key={refKey(claim)} claim={claim} atlas={atlas} onSelect={onSelect} />}
    </Drawer>
  );
}

function ClaimBody({
  claim,
  atlas,
  onSelect,
}: {
  claim: AtlasClaim;
  atlas: KnowledgeAtlas;
  onSelect: (ref: ClaimRef) => void;
}) {
  const detail = useClaimDetail(claim);
  const exception = exceptionOf(claim);
  const mod = moduleOf(claim.statement);
  const revisions = revisionsOf(atlas, claim.id);
  const justifications = detail.support?.justifications ?? [];
  const opposing = claim.evidence.filter((e) => e.direction === "opposes").length;
  const supporting = claim.evidence.length - opposing;

  return (
    <div className="flex flex-col gap-7">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-faint">
          <Chip>
            <span className="inline-flex items-center gap-1.5">
              {KIND_TERMS[claim.kind].term}
              <KindTip kind={claim.kind} />
            </span>
          </Chip>
          {mod && <Chip>{mod}</Chip>}
          <Chip>
            <Term id={claim.scope ? "scope" : "unscoped"}>{scopeLabel(claim.scope ?? null)}</Term>
          </Chip>
          {exception && <ExceptionBadge term={exception.term} tone={exception.tone} />}
        </div>
        <p className="text-[16px] leading-relaxed text-ink">{stripModule(claim.statement)}</p>
      </div>

      <Block title="Why Argus believes it" tip={<Term id="evidence" />}>
        <p className="mb-3 text-[13.5px] text-ink-dim">
          <Term id={claim.support}>{TERMS[claim.support].term}</Term>
          {supportSentence(supporting, opposing, justifications.length)}
        </p>
        {claim.evidence.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {claim.evidence.map((e) => (
              <li
                key={e.id}
                className="flex items-baseline gap-2 rounded-lg border border-line bg-ground-2 px-3 py-2 font-mono text-[11.5px] text-ink-dim"
              >
                <span className={e.direction === "opposes" ? "text-fail" : "text-ink-faint"}>
                  {e.direction === "opposes" ? "−" : "+"}
                </span>
                <span className="min-w-0 break-all">{describeSource(e.source)}</span>
              </li>
            ))}
          </ul>
        )}
        {justifications.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {justifications.map(({ justification: j, force }) => (
              <li
                key={j.id}
                className="rounded-lg border border-line bg-ground-2 px-3 py-2 text-[12.5px]"
              >
                <div className="mb-1 flex items-center gap-2 font-mono text-[11px] text-ink-faint">
                  <Term id="justification">{j.id}</Term>
                  <span>{j.direction}</span>
                  <span className={force.inForce ? "" : "text-run"}>
                    {force.inForce ? "in force" : "out of force"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {j.premises.map((p) => (
                    <button
                      key={refKey(p)}
                      type="button"
                      onClick={() => onSelect(p)}
                      className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-dim transition hover:border-eye/50 hover:text-ink"
                    >
                      {shortId(p.id)}:v{p.revision}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Block>

      {claim.conformance && (
        <Block title="Has anyone checked it?" tip={<Term id={claim.conformance} align="end" />}>
          <p className="text-[13.5px] text-ink-dim">
            <span
              className={
                claim.conformance === "violated"
                  ? "font-semibold text-fail"
                  : "font-semibold text-ink"
              }
            >
              {TERMS[claim.conformance].term}.
            </span>{" "}
            {TERMS[claim.conformance].definition}
          </p>
          {detail.conformance?.latest && (
            <p className="mt-2 font-mono text-[11.5px] text-ink-faint">
              Latest by{" "}
              <a
                className="text-ink-dim hover:text-ink"
                href={`#/run/${encodeURIComponent(detail.conformance.latest.execution.runId)}`}
              >
                {detail.conformance.latest.execution.runId}
              </a>
              {detail.conformance.latest.repository &&
                ` at ${detail.conformance.latest.repository.gitHead.slice(0, 8)}`}
            </p>
          )}
        </Block>
      )}

      <Block
        title="Who relied on it"
        tip={<Term id={claim.stale ? "stale" : "current"} align="end" />}
      >
        <Reliance detail={detail} />
      </Block>

      <Block title="Where it came from">
        <p className="text-[13px] text-ink-dim">
          {claim.producedBy?.runId ? (
            <>
              Produced by{" "}
              <a
                className="font-mono text-ink hover:text-eye"
                href={`#/run/${encodeURIComponent(claim.producedBy.runId)}`}
              >
                {claim.producedBy.phaseId ?? claim.producedBy.runId}
              </a>
            </>
          ) : (
            "Recorded directly, not by a run"
          )}{" "}
          · <TimeAgo iso={claim.createdAt} />
        </p>
        {revisions.length > 1 && (
          <ol className="mt-3 flex flex-col gap-1.5">
            {revisions.map((r) => (
              <li key={r.revision} className="flex items-baseline gap-2 text-[12.5px]">
                <button
                  type="button"
                  onClick={() => onSelect(r)}
                  aria-current={r.revision === claim.revision || undefined}
                  className="font-mono text-[11px] text-ink-faint hover:text-ink aria-[current]:text-eye"
                >
                  v{r.revision}
                </button>
                <span className="line-clamp-1 text-ink-dim">
                  {r.revisionNote ?? stripModule(r.statement)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Block>
    </div>
  );
}

function supportSentence(supporting: number, opposing: number, justifications: number): string {
  const counted = (n: number, noun: string, one: string, many: string) =>
    `${plural(n, noun)} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (supporting > 0) parts.push(counted(supporting, "source", "supports it", "support it"));
  if (opposing > 0) parts.push(counted(opposing, "source", "opposes it", "oppose it"));
  if (justifications > 0) {
    parts.push(counted(justifications, "justification", "bears on it", "bear on it"));
  }
  if (parts.length === 0) return ": nothing currently grounds it.";
  return `: ${parts.join(", ")}${opposing === 0 ? ", and nothing opposes it." : "."}`;
}

function Reliance({ detail }: { detail: ReturnType<typeof useClaimDetail> }) {
  const consumed = detail.consumers?.consumptions ?? [];
  const supplied = detail.suppliedTo?.executions ?? [];
  if (detail.loading) return <p className="text-[13px] text-ink-faint">Loading…</p>;
  if (consumed.length === 0 && supplied.length === 0) {
    return (
      <p className="text-[13px] text-ink-dim">
        No run has used or been given this claim yet. It is recorded, but nothing builds on it.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5 font-mono text-[11.5px]">
      {consumed.map((c) => (
        <RunRow key={`c-${c.execution.runId}`} runId={c.execution.runId} label="used it" />
      ))}
      {supplied.map((s) => (
        <RunRow key={`s-${s.execution.runId}`} runId={s.execution.runId} label="was given it" />
      ))}
    </ul>
  );
}

function RunRow({ runId, label }: { runId: string; label: string }) {
  return (
    <li className="flex items-baseline gap-2 text-ink-faint">
      <a className="text-ink-dim hover:text-ink" href={`#/run/${encodeURIComponent(runId)}`}>
        {runId}
      </a>
      {label}
    </li>
  );
}

function Block({ title, tip, children }: { title: string; tip?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <Eyebrow tip={tip}>{title}</Eyebrow>
      {children}
    </section>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-line px-2.5 py-0.5">{children}</span>;
}
