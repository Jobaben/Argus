import { useMemo, useState } from "react";
import type { AtlasClaim, ClaimRef, KnowledgeAtlas, KnowledgeScope } from "@argus/contracts";
import { AlertStrip, EmptyState, Handoff, Page, SegmentedControl, SkeletonGrid } from "../../ds";
import { useKnowledgeAtlas } from "../../useKnowledgeAtlas";
import {
  NO_FILTER,
  activeClaims,
  filterClaims,
  groupClaims,
  plural,
  refKey,
  scopeKey,
  scopeLabel,
  summarize,
  type ClaimFilter,
  type GroupBy,
} from "../knowledgeModel";
import { ClaimDrawer } from "./ClaimDrawer";
import { ClaimList } from "./ClaimList";
import { FieldGuide } from "./FieldGuide";
import { Term } from "./marks";
import { KindStrip, ModuleShelves } from "./ModuleShelves";

/**
 * The Knowledge view: what the ledger believes, revealed one level at a time.
 * The overview is shelves; a shelf, a kind or a search opens the claims; a
 * claim opens the drawer that says why it is believed. Every word that has a
 * ledger meaning explains itself in place.
 */
export default function KnowledgeView() {
  const [scope, setScope] = useState<KnowledgeScope | null>(null);
  const { data, loading, error } = useKnowledgeAtlas(scope);
  const [guideOpen, setGuideOpen] = useState(false);

  return (
    <Page>
      <header className="relative mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-24 -top-32 -z-10 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgb(54_227_232/0.10),transparent_68%)]"
        />
        <div className="min-w-0">
          <p className="mb-2 flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-eye">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-eye shadow-[0_0_8px_1px_var(--color-eye)]"
            />
            Knowledge ledger
          </p>
          <h1 className="text-board-title font-bold tracking-tight text-ink">
            What Argus believes
          </h1>
          {data && <Summary atlas={data} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data && <ScopePicker atlas={data} value={scope} onChange={setScope} />}
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink-dim transition duration-(--duration-quick) hover:border-eye/50 hover:text-ink"
          >
            <span aria-hidden="true" className="font-mono text-eye">
              ?
            </span>
            How to read this page
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Knowledge" message={`couldn't load the ledger: ${error}`} />
        </div>
      )}
      <Handoff
        busy={loading && !data}
        label="Knowledge ledger"
        skeleton={<SkeletonGrid count={6} columns={3} />}
      >
        {data && data.claims.length > 0 ? (
          // Keyed by scope: a different ledger slice starts from its overview.
          <Explorer key={scopeKey(scope)} atlas={data} />
        ) : (
          !error && (
            <EmptyState>
              The ledger holds no knowledge yet. It fills when a phase that discovers rules or
              writes a knowledge delta has its gate approved.
            </EmptyState>
          )
        )}
      </Handoff>

      <FieldGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </Page>
  );
}

function Summary({ atlas }: { atlas: KnowledgeAtlas }) {
  const s = summarize(atlas);
  return (
    <p className="mt-2 max-w-[68ch] text-[15px] leading-relaxed text-ink-dim">
      <Term id="claim">{plural(s.claims, "claim")}</Term>
      {s.rules > 0 && <>, {plural(s.rules, "business rule")}</>}
      {" · "}
      {s.exceptions === 0 ? (
        <>
          all <Term id="supported">supported</Term>
        </>
      ) : (
        <span className="text-run">{plural(s.exceptions, "needs a look", "need a look")}</span>
      )}
      {s.rules > 0 && (
        <>
          {" · "}
          {s.verified === 0 ? (
            <>
              <b className="font-semibold text-ink">
                none <Term id="unverified">verified</Term>
              </b>
              : nobody has checked them against the code yet.
            </>
          ) : (
            <>
              {s.verified} of {s.rules} rules <Term id="holds">verified</Term>
            </>
          )}
        </>
      )}
      {s.superseded > 0 && (
        <>
          {" · "}
          {plural(s.superseded, "earlier revision")} kept as <Term id="superseded">history</Term>
        </>
      )}
    </p>
  );
}

function ScopePicker({
  atlas,
  value,
  onChange,
}: {
  atlas: KnowledgeAtlas;
  value: KnowledgeScope | null;
  onChange: (scope: KnowledgeScope | null) => void;
}) {
  // Unscoped claims cannot be asked for on their own: absent means unknown,
  // and no query is scoped to "nobody". They show under "All knowledge".
  const owned = atlas.scopes.filter(
    (s): s is { scope: KnowledgeScope; claims: number } => s.scope !== null,
  );
  if (owned.length === 0) return null;
  const total = atlas.scopes.reduce((n, s) => n + s.claims, 0);
  return (
    <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px]">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">
        Scope
      </span>
      <select
        aria-label="Knowledge scope"
        value={scopeKey(value)}
        onChange={(e) =>
          onChange(owned.find((s) => scopeKey(s.scope) === e.target.value)?.scope ?? null)
        }
        className="max-w-[16rem] bg-transparent text-ink outline-none"
      >
        <option value="">All knowledge ({total})</option>
        {owned.map((s) => (
          <option key={scopeKey(s.scope)} value={scopeKey(s.scope)}>
            {scopeLabel(s.scope)} ({s.claims})
          </option>
        ))}
      </select>
    </label>
  );
}

const GROUP_SEGMENTS: Array<{ value: GroupBy; label: string }> = [
  { value: "module", label: "Module" },
  { value: "file", label: "Source file" },
];

function Explorer({ atlas }: { atlas: KnowledgeAtlas }) {
  const [groupBy, setGroupBy] = useState<GroupBy>("module");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClaimFilter>(NO_FILTER);
  const [selected, setSelected] = useState<{ key: string; originY?: number } | null>(null);

  const active = useMemo(() => activeClaims(atlas), [atlas]);
  const groups = useMemo(() => groupClaims(active, groupBy), [active, groupBy]);
  const group = openGroup ? groups.find((g) => g.key === openGroup) : undefined;
  const base = group ? group.claims : active;
  const listing =
    group !== undefined ||
    filter.kind !== null ||
    filter.query.trim() !== "" ||
    filter.exceptionsOnly;
  const shown = useMemo(() => filterClaims(base, filter), [base, filter]);
  const exceptions = useMemo(
    () => filterClaims(base, { ...NO_FILTER, exceptionsOnly: true }).length,
    [base],
  );
  const selectedClaim = selected
    ? (atlas.claims.find((c) => refKey(c) === selected.key) ?? null)
    : null;

  const backToOverview = () => {
    setOpenGroup(null);
    setFilter(NO_FILTER);
  };
  const select = (claim: AtlasClaim | ClaimRef, originY?: number) =>
    setSelected({ key: refKey(claim), originY });

  return (
    <>
      <div className="mb-6">
        <KindStrip
          claims={base}
          active={filter.kind}
          onPick={(kind) => setFilter((f) => ({ ...f, kind }))}
        />
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        {listing ? (
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
            <button
              type="button"
              onClick={backToOverview}
              className="text-ink-faint transition hover:text-ink"
            >
              Knowledge
            </button>
            <span aria-hidden="true" className="text-ink-faint">
              ›
            </span>
            <span className="truncate font-semibold text-ink">{group?.label ?? "All claims"}</span>
            <span className="font-mono text-[12px] text-ink-faint">{shown.length}</span>
          </nav>
        ) : (
          <SegmentedControl
            label="Group claims by"
            segments={GROUP_SEGMENTS}
            value={groupBy}
            onChange={setGroupBy}
          />
        )}
        {exceptions > 0 && (
          <button
            type="button"
            aria-pressed={filter.exceptionsOnly}
            onClick={() => setFilter((f) => ({ ...f, exceptionsOnly: !f.exceptionsOnly }))}
            className={`rounded-full border px-3 py-1 text-[12.5px] transition ${
              filter.exceptionsOnly
                ? "border-run/60 bg-run/10 text-run"
                : "border-line text-ink-dim hover:border-run/50 hover:text-ink"
            }`}
          >
            Only what needs a look · {exceptions}
          </button>
        )}
        <label className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 sm:ml-auto sm:max-w-sm">
          <span aria-hidden="true" className="text-xs text-ink-faint">
            ⌕
          </span>
          <input
            type="search"
            aria-label="Search claims by text, id or file"
            placeholder="Search statements, ids, files"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            className="w-full bg-transparent text-sm text-ink placeholder-ink-faint outline-none"
          />
        </label>
      </div>

      {listing ? (
        <ClaimList
          claims={shown}
          selected={selected?.key ?? null}
          showModule={groupBy !== "module" || group === undefined}
          onSelect={select}
        />
      ) : (
        <ModuleShelves groups={groups} onOpen={setOpenGroup} />
      )}

      <ClaimDrawer
        claim={selectedClaim}
        atlas={atlas}
        originY={selected?.originY}
        onClose={() => setSelected(null)}
        onSelect={(ref) => select(ref)}
      />
    </>
  );
}
