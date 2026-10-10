import type { AtlasClaim, ClaimKind } from "@argus/contracts";
import { InfoTip, staggerDelay } from "../../ds";
import { KIND_TERMS } from "../knowledgeGlossary";
import { kindCounts, plural, type ClaimGroup } from "../knowledgeModel";
import { KindMark } from "./marks";

/**
 * The overview: one quiet card per shelf. A card only draws the eye (an
 * accent edge and a count) when something on it needs attention.
 */
export function ModuleShelves({
  groups,
  onOpen,
}: {
  groups: ClaimGroup[];
  onOpen: (key: string) => void;
}) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {groups.map((g, i) => (
        <li
          key={g.key}
          style={{ animationDelay: staggerDelay(i) }}
          className="motion-safe:animate-[rise-in_var(--duration-base)_var(--ease-out-expo)_both]"
        >
          <button
            type="button"
            onClick={() => onOpen(g.key)}
            className={`group flex h-full w-full flex-col gap-3 rounded-tile border bg-surface p-4 text-left transition duration-(--duration-quick) hover:bg-surface-2 motion-safe:active:scale-[0.99] ${
              g.exceptions > 0
                ? "border-run/40 shadow-[inset_3px_0_0_var(--color-run)]"
                : "border-line hover:border-ink-faint/40"
            }`}
          >
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate font-semibold text-ink">{g.label}</span>
                {g.detail && (
                  <span className="block truncate font-mono text-[11px] text-ink-faint">
                    {g.detail}
                  </span>
                )}
              </span>
              <span className="font-mono text-2xl font-bold leading-none tabular-nums text-ink-dim transition group-hover:text-ink">
                {g.claims.length}
              </span>
            </span>
            <KindDots claims={g.claims} />
            <span className="mt-auto flex items-center justify-between gap-2 text-[12px]">
              <span className="min-w-0 truncate font-mono text-ink-faint">
                {g.topFiles.join(" · ")}
              </span>
              {g.exceptions > 0 && (
                <span className="shrink-0 font-mono text-[11px] font-bold text-run">
                  {plural(g.exceptions, "needs a look", "need a look")}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function KindDots({ claims }: { claims: AtlasClaim[] }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-dim">
      {kindCounts(claims).map(({ kind, count }) => (
        <span key={kind} className="inline-flex items-center gap-1">
          <KindMark kind={kind} />
          <span className="tabular-nums">{count}</span>
          <span className="sr-only">{KIND_TERMS[kind].term}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * The ledger's composition in one bar: each kind's share, by glyph and a
 * gently stepped tone. Clicking a kind lists exactly those claims.
 */
export function KindStrip({
  claims,
  active,
  onPick,
}: {
  claims: AtlasClaim[];
  active: ClaimKind | null;
  onPick: (kind: ClaimKind | null) => void;
}) {
  const counts = kindCounts(claims);
  const total = claims.length || 1;
  const shade = ["bg-ink/70", "bg-ink/45", "bg-ink/30", "bg-ink/20", "bg-ink/14", "bg-ink/10"];
  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
        What kind of knowledge
        <InfoTip title="Kinds">
          Every claim is one of six kinds. The glyph always shows the kind, so colour stays free to
          mean something is wrong. Click a kind to list it.
        </InfoTip>
      </div>
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
        {counts.map(({ kind, count }, i) => (
          <span
            key={kind}
            style={{ width: `${(count / total) * 100}%` }}
            className={`h-full min-w-1 transition-opacity duration-(--duration-base) ${shade[i]} ${
              active && active !== kind ? "opacity-30" : ""
            }`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter by kind">
        {counts.map(({ kind, count }) => {
          const on = active === kind;
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(on ? null : kind)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition duration-(--duration-quick) ${
                on
                  ? "border-eye/60 bg-eye/10 text-ink"
                  : "border-line text-ink-dim hover:border-ink-faint/50 hover:text-ink"
              }`}
            >
              <KindMark kind={kind} />
              {KIND_TERMS[kind].term}
              <span className="font-mono text-ink-faint tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
