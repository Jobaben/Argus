import { Drawer } from "../../ds/Drawer";
import type { ReactNode } from "react";
import type { AtlasClaim, ClaimRef, KnowledgeAtlas } from "@argus/contracts";
import { Icon, Loading, SkeletonText, TimeAgo, buttonClass, chipClass } from "../../ds";
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
          <span className="flex min-w-0 items-center gap-2">
            <KindMark kind={claim.kind} size={16} />
            {KIND_TERMS[claim.kind].term}
            <span className="truncate font-mono text-small font-normal text-ink-faint">
              {shortId(claim.id)}
            </span>
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

/** Small metadata chips under the statement: kind, module, scope. */
const CHIP = chipClass();

/** A run as a link to it, labelled with its id unless something better is given. */
function RunLink({ runId, children }: { runId: string; children?: ReactNode }) {
  return (
    <a
      className="font-mono text-ink-dim underline decoration-line-strong underline-offset-2 transition-colors duration-(--duration-quick) hover:text-ink hover:decoration-ink-faint"
      href={`#/run/${encodeURIComponent(runId)}`}
    >
      {children ?? runId}
    </a>
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
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className={CHIP}>
            {KIND_TERMS[claim.kind].term}
            <KindTip kind={claim.kind} />
          </span>
          {mod && <span className={CHIP}>{mod}</span>}
          <span className={CHIP}>
            <Term id={claim.scope ? "scope" : "unscoped"}>{scopeLabel(claim.scope ?? null)}</Term>
          </span>
          {exception && <ExceptionBadge term={exception.term} tone={exception.tone} />}
        </div>
        <p className="text-title font-normal leading-relaxed text-ink">
          {stripModule(claim.statement)}
        </p>
      </div>

      <Block title="Why Argus believes it" tip={<Term id="evidence" />}>
        <p className="mb-3 text-small text-ink-dim">
          <Term id={claim.support}>{TERMS[claim.support].term}</Term>
          {supportSentence(supporting, opposing, justifications.length)}
        </p>
        {claim.evidence.length > 0 && (
          <ul className="divide-y divide-line rounded-control bg-ground-2/70">
            {claim.evidence.map((e) => {
              const opposes = e.direction === "opposes";
              return (
                <li
                  key={e.id}
                  className="flex items-start gap-2.5 px-3 py-2 font-mono text-caption text-ink-dim"
                >
                  <Icon
                    name={opposes ? "minus" : "plus"}
                    size={13}
                    strokeWidth={2.25}
                    label={opposes ? "Opposes" : "Supports"}
                    className={`mt-px ${opposes ? "text-fail" : "text-ink-faint"}`}
                  />
                  <span className="min-w-0 break-all">{describeSource(e.source)}</span>
                </li>
              );
            })}
          </ul>
        )}
        {justifications.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {justifications.map(({ justification: j, force }) => (
              <li key={j.id} className="rounded-control bg-ground-2/70 px-3 py-2.5 text-small">
                <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption text-ink-faint">
                  <span className="font-mono">
                    <Term id="justification">{j.id}</Term>
                  </span>
                  <span>{j.direction}</span>
                  <span
                    className={
                      force.inForce ? "text-ink-dim" : "inline-flex font-semibold text-await"
                    }
                  >
                    {force.inForce ? "in force" : "out of force"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-caption text-ink-faint">Premises</span>
                  {j.premises.map((p) => (
                    <button
                      key={refKey(p)}
                      type="button"
                      onClick={() => onSelect(p)}
                      className={buttonClass("secondary", "sm", "font-mono")}
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
          <p className="text-small text-ink-dim">
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
            <p className="mt-2 text-caption text-ink-faint">
              Latest by <RunLink runId={detail.conformance.latest.execution.runId} />
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
        <p className="text-small text-ink-dim">
          {claim.producedBy?.runId ? (
            <>
              Produced by{" "}
              <RunLink runId={claim.producedBy.runId}>
                {claim.producedBy.phaseId ?? claim.producedBy.runId}
              </RunLink>
            </>
          ) : (
            "Recorded directly, not by a run"
          )}{" "}
          · <TimeAgo iso={claim.createdAt} />
        </p>
        {revisions.length > 1 && (
          <ol className="mt-3 flex flex-col gap-1 border-l border-line pl-3">
            {revisions.map((r) => (
              <li key={r.revision} className="flex items-baseline gap-2.5 text-small">
                <button
                  type="button"
                  onClick={() => onSelect(r)}
                  aria-current={r.revision === claim.revision || undefined}
                  className="shrink-0 rounded-sm font-mono text-caption text-ink-faint transition-colors duration-(--duration-quick) hover:text-ink aria-[current]:font-semibold aria-[current]:text-eye"
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
  if (detail.loading) {
    return (
      <Loading label="who relied on it">
        <SkeletonText lines={2} />
      </Loading>
    );
  }
  if (consumed.length === 0 && supplied.length === 0) {
    return (
      <p className="text-small text-ink-dim">
        No run has used or been given this claim yet. It is recorded, but nothing builds on it.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line rounded-control bg-ground-2/70">
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
    <li className="flex items-baseline gap-2 px-3 py-2 text-caption text-ink-faint">
      <RunLink runId={runId} />
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
