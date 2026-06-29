import { useState } from "react";
import { AlertStrip, EmptyState } from "../ds";
import {
  useInventory,
  type InventoryItem,
  type PluginItem,
} from "../useInventory";

type AccentToken = "ok" | "queue" | "run" | "await" | "fail";

const ACCENT: Record<AccentToken, string> = {
  ok: "bg-ok/12 text-ok ring-ok/20",
  queue: "bg-queue/12 text-queue ring-queue/20",
  run: "bg-run/12 text-run ring-run/20",
  await: "bg-await/14 text-await ring-await/20",
  fail: "bg-fail/14 text-fail ring-fail/20",
};

function ItemRow({ name, description, badge }: { name: string; description: string; badge?: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface px-4 py-3 transition hover:border-ink-faint/40">
      <div className="flex items-baseline gap-x-2">
        <span className="truncate font-mono text-sm font-semibold text-ink" title={name}>
          {name}
        </span>
        {badge && <span className="shrink-0 text-xs text-ink-faint">{badge}</span>}
      </div>
      {description && (
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">{description}</p>
      )}
    </div>
  );
}

function InventorySection<T>({
  title,
  accent,
  items,
  render,
  keyOf,
}: {
  title: string;
  accent: AccentToken;
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
        <span className="text-ink-faint transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>
          ›
        </span>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${ACCENT[accent]}`}>
          {items.length}
        </span>
      </button>
      {open &&
        (items.length === 0 ? (
          <p className="pl-6 text-xs text-ink-faint">None found.</p>
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
        <h2 className="text-xl font-semibold text-ink">Extensions</h2>
        <p className="mt-1 text-sm text-ink-faint">
          Agents, commands, skills, and plugins installed under ~/.claude
        </p>
      </header>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Extensions" message={`Couldn't load inventory: ${error}`} />
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading inventory…</p>
      ) : !inventory ? (
        <EmptyState>No extensions found yet.</EmptyState>
      ) : (
        <>
          <InventorySection<InventoryItem>
            title="Agents"
            accent="ok"
            items={inventory.agents}
            keyOf={(a) => a.name}
            render={(a) => ({ name: a.name, description: a.description })}
          />
          <InventorySection<InventoryItem>
            title="Commands"
            accent="queue"
            items={inventory.commands}
            keyOf={(c) => c.name}
            render={(c) => ({ name: c.name, description: c.description })}
          />
          <InventorySection<InventoryItem>
            title="Skills"
            accent="run"
            items={inventory.skills}
            keyOf={(s) => s.name}
            render={(s) => ({ name: s.name, description: s.description })}
          />
          <InventorySection<PluginItem>
            title="Plugins"
            accent="fail"
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
