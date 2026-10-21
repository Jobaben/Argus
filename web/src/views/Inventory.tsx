import { useState } from "react";
import {
  AlertStrip,
  Button,
  EmptyState,
  Handoff,
  Icon,
  Page,
  SkeletonRows,
  chipClass,
  fieldClass,
} from "../ds";
import { useInventory, type InventoryItem, type PluginItem } from "../useInventory";
import { loadError } from "../live/loadError";

/** A path is machine text, in the mono face like the subtitle's. */
const PATH = "font-mono text-caption text-ink";

interface Row {
  key: string;
  name: string;
  description: string;
  version?: string;
  source?: string;
  /** False where the source never carries a description, so a missing one is
   *  not worth a line saying so. */
  describable?: boolean;
}

function matches(row: Row, q: string): boolean {
  if (!q) return true;
  return (
    row.name.toLowerCase().includes(q) ||
    row.description.toLowerCase().includes(q) ||
    (row.source?.toLowerCase().includes(q) ?? false)
  );
}

function ItemRow({ row }: { row: Row }) {
  return (
    <li className="grid grid-cols-1 gap-1 px-4 py-3 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] md:gap-6">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {/* An extension's name is what you type to invoke it: machine text. */}
        <span className="truncate font-mono text-small text-ink" title={row.name}>
          {row.name}
        </span>
        {row.version && (
          <span className={chipClass()}>
            {/^v/i.test(row.version) ? row.version : `v${row.version}`}
          </span>
        )}
        {row.source && (
          <span className="truncate text-caption text-ink-faint" title={`From ${row.source}`}>
            from {row.source}
          </span>
        )}
      </div>
      {row.description ? (
        <p className="line-clamp-3 min-w-0 text-small text-ink-dim">{row.description}</p>
      ) : row.describable === false ? null : (
        <p className="text-small italic text-ink-faint">No description.</p>
      )}
    </li>
  );
}

/**
 * One kind of extension: a disclosure heading with its count, then one panel of
 * rows. The count is a neutral chip — these are categories, not states, and a
 * red "Plugins 2" read as an alert about nothing.
 */
function InventorySection({
  title,
  where,
  emptyHint,
  rows,
  total,
  filtering,
}: {
  title: string;
  /** Where these live on disk, shown beside the heading. */
  where: string;
  emptyHint: string;
  rows: Row[];
  total: number;
  filtering: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="mb-8">
      <h2 className="mb-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="group flex w-full min-w-0 items-center gap-2 rounded-control py-1 text-left"
        >
          <Icon
            name="chevron-right"
            size={16}
            className={`text-ink-faint transition-transform duration-(--duration-quick) ease-(--ease-out-expo) group-hover:text-ink ${
              open ? "rotate-90" : ""
            }`}
          />
          <span className="text-heading font-semibold text-ink">{title}</span>
          <span className={chipClass()}>{filtering ? `${rows.length} of ${total}` : total}</span>
          <span className="ml-auto hidden truncate font-mono text-caption text-ink-faint sm:block">
            {where}
          </span>
        </button>
      </h2>
      {open &&
        (rows.length === 0 ? (
          <p className="rounded-tile border border-line bg-surface/50 px-4 py-3 text-small text-ink-faint">
            {filtering ? `No ${title.toLowerCase()} match.` : emptyHint}
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
            {rows.map((r) => (
              <ItemRow key={r.key} row={r} />
            ))}
          </ul>
        ))}
    </section>
  );
}

const item = (i: InventoryItem): Row => ({ key: i.name, name: i.name, description: i.description });
// The server fills a plugin's gaps with stand-ins — "from <marketplace>" for a
// missing description, "unknown" for a missing version. The row already says
// where a plugin came from, and a "vunknown" chip is not a version, so both
// are dropped back to the absences they stand for. The install record carries
// no description at all, so a plugin without one is the norm, not news.
const plugin = (p: PluginItem): Row => ({
  key: `${p.name}@${p.marketplace}`,
  name: p.name,
  description: p.description === `from ${p.marketplace}` ? "" : p.description,
  version: p.version && p.version !== "unknown" ? p.version : undefined,
  source: p.marketplace,
  describable: false,
});

export default function Inventory() {
  const { inventory, loading, error, refresh } = useInventory();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const groups = inventory
    ? [
        {
          title: "Agents",
          where: "~/.claude/agents",
          emptyHint: "None installed. An agent is a Markdown file in ~/.claude/agents.",
          all: inventory.agents.map(item),
        },
        {
          title: "Commands",
          where: "~/.claude/commands",
          emptyHint: "None installed. A slash command is a Markdown file in ~/.claude/commands.",
          all: inventory.commands.map(item),
        },
        {
          title: "Skills",
          where: "~/.claude/skills",
          emptyHint: "None installed. A skill is a Markdown file in ~/.claude/skills.",
          all: inventory.skills.map(item),
        },
        {
          title: "Plugins",
          where: "~/.claude/plugins",
          emptyHint: "None installed. Plugins arrive from a marketplace through Claude Code.",
          all: inventory.plugins.map(plugin),
        },
      ]
    : [];
  const total = groups.reduce((n, g) => n + g.all.length, 0);
  const visible = groups
    .map((g) => ({ ...g, rows: g.all.filter((r) => matches(r, q)) }))
    // While filtering, a kind with no matches is noise; at rest, an empty kind
    // still says where its files would go.
    .filter((g) => !q || g.rows.length > 0);

  return (
    <Page
      title="Inventory"
      subtitle={
        <>
          Agents, commands, skills and plugins installed under{" "}
          <code className="font-mono text-caption text-ink">~/.claude</code>.
        </>
      }
      actions={
        total > 0 ? (
          <label className="relative block">
            <span className="sr-only">Filter extensions</span>
            <Icon
              name="search"
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name or description"
              className={`${fieldClass} h-8 w-64 max-w-full pl-8`}
            />
          </label>
        ) : undefined
      }
    >
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Inventory"
            message={loadError("the inventory", error)}
            action={
              <Button size="sm" icon="retry" onClick={() => refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      <Handoff busy={loading} label="inventory" skeleton={<SkeletonRows count={5} />}>
        {!inventory ? (
          // With an error up top, "nothing found" would be a guess.
          error ? null : (
            <EmptyState icon="folder" title="No extensions found yet">
              Argus lists what Claude Code has installed under{" "}
              <code className={PATH}>~/.claude</code>. Nothing has been reported yet.
            </EmptyState>
          )
        ) : total === 0 ? (
          <EmptyState
            icon="folder"
            title={
              <>
                Nothing installed under <code className="font-mono text-ink">~/.claude</code> yet
              </>
            }
            action={
              <Button icon="retry" onClick={() => refresh()}>
                Check again
              </Button>
            }
          >
            Agents, commands and skills are Markdown files in{" "}
            <code className={PATH}>~/.claude/agents</code>,{" "}
            <code className={PATH}>~/.claude/commands</code> and{" "}
            <code className={PATH}>~/.claude/skills</code>; plugins arrive from a marketplace
            through Claude Code. This page picks them up as soon as they appear.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            icon="search"
            title={`Nothing matches “${query.trim()}”`}
            action={
              <Button size="sm" onClick={() => setQuery("")}>
                Clear filter
              </Button>
            }
          >
            The filter looks at names, descriptions and plugin marketplaces.
          </EmptyState>
        ) : (
          visible.map((g) => (
            <InventorySection
              key={g.title}
              title={g.title}
              where={g.where}
              emptyHint={g.emptyHint}
              rows={g.rows}
              total={g.all.length}
              filtering={q !== ""}
            />
          ))
        )}
      </Handoff>
    </Page>
  );
}
