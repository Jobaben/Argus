import { useState } from "react";
import {
  useInventory,
  type InventoryItem,
  type PluginItem,
} from "../useInventory";

type AccentColor = "emerald" | "amber" | "sky" | "rose";

const ACCENT: Record<AccentColor, string> = {
  emerald: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20",
  amber: "bg-amber-500/10 text-amber-300 ring-amber-500/20",
  sky: "bg-sky-500/10 text-sky-300 ring-sky-500/20",
  rose: "bg-rose-500/10 text-rose-300 ring-rose-500/20",
};

function ItemRow({ name, description, badge }: { name: string; description: string; badge?: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 transition hover:border-white/20 hover:bg-white/[0.05]">
      <div className="flex items-baseline gap-x-2">
        <span className="truncate font-mono text-sm font-semibold text-white" title={name}>
          {name}
        </span>
        {badge && <span className="shrink-0 text-xs text-white/40">{badge}</span>}
      </div>
      {description && (
        <p className="mt-1 text-xs leading-relaxed text-white/45">{description}</p>
      )}
    </div>
  );
}

function Section<T>({
  title,
  accent,
  items,
  render,
  keyOf,
}: {
  title: string;
  accent: AccentColor;
  items: T[];
  render: (item: T) => { name: string; description: string; badge?: string };
  keyOf: (item: T) => string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="mb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-3 flex w-full items-center gap-x-3 text-left"
      >
        <span className="text-white/40 transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>
          ›
        </span>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${ACCENT[accent]}`}>
          {items.length}
        </span>
      </button>
      {open &&
        (items.length === 0 ? (
          <p className="pl-6 text-xs text-white/30">None found.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 pl-6 sm:grid-cols-2">
            {items.map((item) => {
              const r = render(item);
              return <ItemRow key={keyOf(item)} {...r} />;
            })}
          </div>
        ))}
    </section>
  );
}

export default function Inventory() {
  const { inventory, loading, error } = useInventory();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <h2 className="text-xl font-semibold text-white">Extensions</h2>
        <p className="mt-1 text-sm text-white/45">
          Agents, commands, skills, and plugins installed under ~/.claude
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t load inventory: {error}
        </div>
      )}

      {loading ? (
        <p className="text-white/40">Loading inventory…</p>
      ) : !inventory ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No extensions found yet.
        </div>
      ) : (
        <>
          <Section<InventoryItem>
            title="Agents"
            accent="emerald"
            items={inventory.agents}
            keyOf={(a) => a.name}
            render={(a) => ({ name: a.name, description: a.description })}
          />
          <Section<InventoryItem>
            title="Commands"
            accent="sky"
            items={inventory.commands}
            keyOf={(c) => c.name}
            render={(c) => ({ name: c.name, description: c.description })}
          />
          <Section<InventoryItem>
            title="Skills"
            accent="amber"
            items={inventory.skills}
            keyOf={(s) => s.name}
            render={(s) => ({ name: s.name, description: s.description })}
          />
          <Section<PluginItem>
            title="Plugins"
            accent="rose"
            items={inventory.plugins}
            keyOf={(p) => `${p.name}@${p.marketplace}`}
            render={(p) => ({
              name: p.name,
              description: p.description,
              badge: p.version,
            })}
          />
        </>
      )}
    </div>
  );
}
