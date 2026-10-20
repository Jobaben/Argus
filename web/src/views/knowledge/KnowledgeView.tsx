import { useMemo, useRef, useState } from "react";
import type { AtlasClaim, ClaimRef, KnowledgeAtlas, KnowledgeScope } from "@argus/contracts";
import {
  AlertStrip,
  Button,
  ButtonLink,
  EmptyState,
  Handoff,
  Icon,
  Page,
  SegmentedControl,
  SkeletonGrid,
  fieldClass,
  labelClass,
} from "../../ds";
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
  const { data, loading, error, refresh } = useKnowledgeAtlas(scope);
  const [guideOpen, setGuideOpen] = useState(false);
  const openGuide = () => setGuideOpen(true);

  return (
    <Page
      title="What Argus believes"
      subtitle={
        data && data.claims.length > 0 ? (
          <Summary atlas={data} />
        ) : (
          "The knowledge ledger: what Argus has learned about your code, the evidence behind each claim, and who relied on it."
        )
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {data && <ScopePicker atlas={data} value={scope} onChange={setScope} />}
          <Button icon="info" onClick={openGuide}>
            How to read this page
          </Button>
        </div>
      }
    >
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Knowledge"
            message={`Couldn't load the ledger: ${error}`}
            action={
              <Button size="sm" icon="retry" onClick={refresh}>
                Retry
              </Button>
            }
          />
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
            <EmptyState
              icon="layers"
              title="The ledger holds no knowledge yet"
              action={
                // One next step. The field guide is the header's "How to read
                // this page", a few pixels above.
                <ButtonLink href="#/pipelines" variant="primary" iconRight="arrow-right">
                  Open pipelines
                </ButtonLink>
              }
            >
              It fills when a pipeline phase that discovers rules or writes a knowledge delta has
              its gate approved. Each claim then appears here with the evidence behind it and the
              runs that relied on it.
            </EmptyState>
          )
        )}
      </Handoff>

      <FieldGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </Page>
  );
}

/** The one-line state of the ledger, set as the page's subtitle. A fragment,
 *  since `Page` wraps it in its own paragraph. */
function Summary({ atlas }: { atlas: KnowledgeAtlas }) {
  const s = summarize(atlas);
  return (
    <>
      <Term id="claim">{plural(s.claims, "claim")}</Term>
      {s.rules > 0 && <>, {plural(s.rules, "business rule")}</>}
      {" · "}
      {s.exceptions === 0 ? (
        <>
          all <Term id="supported">supported</Term>
        </>
      ) : (
        <span className="font-semibold text-run">
          {plural(s.exceptions, "needs a look", "need a look")}
        </span>
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
    </>
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
    <label className="flex min-w-0 items-center gap-2">
      <span className={labelClass}>Scope</span>
      <select
        aria-label="Knowledge scope"
        value={scopeKey(value)}
        onChange={(e) =>
          onChange(owned.find((s) => scopeKey(s.scope) === e.target.value)?.scope ?? null)
        }
        className={`${fieldClass} h-8 w-full max-w-[16rem] cursor-pointer`}
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
  const searchRef = useRef<HTMLInputElement>(null);

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
      <div className="mb-6 rounded-tile border border-line bg-surface px-4 py-3.5 shadow-raised">
        <KindStrip
          claims={base}
          active={filter.kind}
          onPick={(kind) => setFilter((f) => ({ ...f, kind }))}
        />
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2.5">
        {listing ? (
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <Button variant="ghost" size="sm" className="-ml-2.5" onClick={backToOverview}>
              Knowledge
            </Button>
            <Icon name="chevron-right" size={13} className="text-ink-faint/70" />
            <span className="truncate font-semibold text-ink">{group?.label ?? "All claims"}</span>
            <span className="rounded-full bg-surface-3 px-1.5 py-px text-micro font-semibold tabular-nums text-ink-dim">
              {shown.length}
            </span>
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
            className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-caption font-semibold transition duration-(--duration-quick) motion-safe:active:scale-[0.97] ${
              filter.exceptionsOnly
                ? "border-run/50 bg-run/10 text-run"
                : "border-line-strong text-ink-dim hover:border-run/40 hover:bg-surface-2 hover:text-ink"
            }`}
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-run" />
            Only what needs a look · {exceptions}
          </button>
        )}
        <label className="relative flex min-w-0 flex-[1_1_14rem] items-center sm:ml-auto sm:max-w-sm">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute left-2.5 text-ink-faint"
          />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search claims by text, id or file"
            placeholder="Search statements, ids, files"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            className={`${fieldClass} h-8 w-full pl-8`}
          />
        </label>
      </div>

      {listing ? (
        <ClaimList
          claims={shown}
          selected={selected?.key ?? null}
          showModule={groupBy !== "module" || group === undefined}
          onSelect={select}
          onClearFilters={() => {
            // Clearing can unmount the button that did it (with no shelf open
            // the overview replaces the list), so focus goes somewhere useful
            // rather than falling to the page.
            setFilter(NO_FILTER);
            searchRef.current?.focus();
          }}
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
