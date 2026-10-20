import type { AtlasClaim, ClaimKind } from "@argus/contracts";
import { Icon, staggerDelay } from "../../ds";
import { KIND_TERMS } from "../knowledgeGlossary";
import { kindCounts, plural, type ClaimGroup } from "../knowledgeModel";
import { KindMark } from "./marks";
import { InfoTip } from "../../ds/InfoTip";

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
            className="group relative flex h-full w-full flex-col gap-3 overflow-hidden rounded-tile border border-line bg-surface p-4 text-left shadow-raised transition duration-(--duration-quick) hover:border-line-strong hover:bg-surface-2 motion-safe:active:scale-[0.99]"
          >
            {/* The accent edge, the same rule `HealthCounter` draws on a tile
                that has something to say. */}
            {g.exceptions > 0 && (
              <span
                aria-hidden="true"
                className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-run"
              />
            )}
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate text-heading font-semibold text-ink">
                  {g.label}
                </span>
                {g.detail && (
                  <span className="mt-0.5 block truncate font-mono text-caption text-ink-faint">
                    {g.detail}
                  </span>
                )}
              </span>
              <span className="text-glance-sm font-semibold leading-none tabular-nums text-ink-dim transition-colors duration-(--duration-quick) group-hover:text-ink">
                {g.claims.length}
              </span>
            </span>
            <KindDots claims={g.claims} />
            <span className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-3 text-caption">
              <span className="min-w-0 truncate font-mono text-ink-faint">
                {g.topFiles.join(" · ")}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {g.exceptions > 0 && (
                  <span className="inline-flex items-center gap-1.5 font-semibold text-run">
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                    {plural(g.exceptions, "needs a look", "need a look")}
                  </span>
                )}
                <Icon
                  name="chevron-right"
                  size={15}
                  className="text-ink-faint transition-transform duration-(--duration-quick) group-hover:translate-x-0.5 group-hover:text-ink-dim"
                />
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function KindDots({ claims }: { claims: AtlasClaim[] }) {
  return (
    <span className="flex flex-wrap gap-x-3.5 gap-y-1 text-small text-ink-dim">
      {kindCounts(claims).map(({ kind, count }) => (
        <span key={kind} className="inline-flex items-center gap-1.5">
          <KindMark kind={kind} size={13} />
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
      <div className="eyebrow mb-2.5 flex items-center gap-2">
        What kind of knowledge
        <InfoTip title="Kinds">
          Every claim is one of six kinds. The glyph always shows the kind, so colour stays free to
          mean something is wrong. Click a kind to list it.
        </InfoTip>
      </div>
      <div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
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
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
        {counts.map(({ kind, count }) => {
          const on = active === kind;
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(on ? null : kind)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-full border pl-2.5 pr-3 text-caption font-semibold transition duration-(--duration-quick) motion-safe:active:scale-[0.97] ${
                on
                  ? "border-eye/50 bg-eye/10 text-ink"
                  : "border-line-strong text-ink-dim hover:border-ink-faint/50 hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <KindMark kind={kind} size={13} />
              {KIND_TERMS[kind].term}
              <span className="font-normal tabular-nums text-ink-faint">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
