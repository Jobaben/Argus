import type { AtlasClaim } from "@argus/contracts";
import { EmptyState } from "../../ds";
import { KIND_TERMS } from "../knowledgeGlossary";
import {
  KIND_ORDER,
  codePaths,
  exceptionOf,
  moduleOf,
  plural,
  refKey,
  shortId,
  stripModule,
} from "../knowledgeModel";
import { ExceptionBadge, Eyebrow, KindMark, KindTip } from "./marks";

/**
 * Claims under quiet kind headings. A row is its statement first; the id and
 * the evidence count are muted, and a badge appears only when something is off.
 */
export function ClaimList({
  claims,
  selected,
  showModule,
  onSelect,
}: {
  claims: AtlasClaim[];
  selected: string | null;
  /** Whether to show each row's module, which is noise inside one module. */
  showModule: boolean;
  onSelect: (claim: AtlasClaim, originY: number) => void;
}) {
  if (claims.length === 0) {
    return <EmptyState>No claims match. Try a broader search or clear the filters.</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-7">
      {KIND_ORDER.map((kind) => {
        const ofKind = claims.filter((c) => c.kind === kind);
        if (ofKind.length === 0) return null;
        return (
          <section key={kind}>
            <Eyebrow tip={<KindTip kind={kind} />}>
              <KindMark kind={kind} />
              {KIND_TERMS[kind].term}
              <span className="text-ink-faint/70">{ofKind.length}</span>
            </Eyebrow>
            <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface">
              {ofKind.map((c) => (
                <ClaimRow
                  key={refKey(c)}
                  claim={c}
                  selected={selected === refKey(c)}
                  showModule={showModule}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ClaimRow({
  claim,
  selected,
  showModule,
  onSelect,
}: {
  claim: AtlasClaim;
  selected: boolean;
  showModule: boolean;
  onSelect: (claim: AtlasClaim, originY: number) => void;
}) {
  const exception = exceptionOf(claim);
  const mod = showModule ? moduleOf(claim.statement) : null;
  const files = codePaths(claim).length;
  return (
    <li>
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={(e) => onSelect(claim, e.currentTarget.getBoundingClientRect().top)}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left transition duration-(--duration-quick) hover:bg-surface-2 ${
          selected ? "bg-surface-2 shadow-[inset_2px_0_0_var(--color-eye)]" : ""
        }`}
      >
        <KindMark kind={claim.kind} className="mt-1" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[14px] leading-snug text-ink">
            {stripModule(claim.statement)}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-ink-faint">
            <span>{shortId(claim.id)}</span>
            {mod && <span>{mod}</span>}
            <span>
              {files > 0 ? plural(files, "file") : plural(claim.evidence.length, "source")}
            </span>
          </span>
        </span>
        {exception && <ExceptionBadge term={exception.term} tone={exception.tone} />}
      </button>
    </li>
  );
}
