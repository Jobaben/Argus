import type { AtlasClaim } from "@argus/contracts";
import { Button, EmptyState, Icon } from "../../ds";
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
  onClearFilters,
}: {
  claims: AtlasClaim[];
  selected: string | null;
  /** Whether to show each row's module, which is noise inside one module. */
  showModule: boolean;
  onSelect: (claim: AtlasClaim, originY: number) => void;
  /** Offered as the way out of an empty result. */
  onClearFilters?: () => void;
}) {
  if (claims.length === 0) {
    return (
      <EmptyState
        icon="search"
        title="No claims match"
        action={
          onClearFilters && (
            <Button size="sm" icon="close" onClick={onClearFilters}>
              Clear filters
            </Button>
          )
        }
      >
        Nothing fits the search and filters you have set. Try a broader search, or clear them.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-7">
      {KIND_ORDER.map((kind) => {
        const ofKind = claims.filter((c) => c.kind === kind);
        if (ofKind.length === 0) return null;
        return (
          <section key={kind}>
            <Eyebrow tip={<KindTip kind={kind} />}>
              <KindMark kind={kind} size={12} />
              {KIND_TERMS[kind].term}
              <span className="font-normal tabular-nums text-ink-faint/80">{ofKind.length}</span>
            </Eyebrow>
            <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
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
        className={`group flex w-full items-start gap-3 px-4 py-3 text-left transition duration-(--duration-quick) hover:bg-surface-2/60 ${
          selected ? "bg-surface-2 shadow-[inset_2px_0_0_var(--color-eye)]" : ""
        }`}
      >
        <KindMark kind={claim.kind} className="mt-[3px]" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-body leading-snug text-ink">
            {stripModule(claim.statement)}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-ink-faint">
            <span className="font-mono">{shortId(claim.id)}</span>
            {mod && <span>{mod}</span>}
            <span>
              {files > 0 ? plural(files, "file") : plural(claim.evidence.length, "source")}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 self-center">
          {exception && <ExceptionBadge term={exception.term} tone={exception.tone} />}
          <Icon
            name="chevron-right"
            size={15}
            className="text-ink-faint transition-colors duration-(--duration-quick) group-hover:text-ink-dim"
          />
        </span>
      </button>
    </li>
  );
}
