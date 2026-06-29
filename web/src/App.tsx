import { useEffect, useMemo, useState } from "react";
import { useAgents } from "./useAgents";
import type { AgentStatus } from "./types";
import { AgentTile, HealthCounter, ConnectionPill, IrisMark, EmptyState } from "./ds";
import Sessions from "./views/Sessions";
import ActivityFeed from "./views/ActivityFeed";
import Projects from "./views/Projects";
import Stats from "./views/Stats";
import Inventory from "./views/Inventory";
import Tasks from "./views/Tasks";
import Search from "./views/Search";
import Cron from "./views/Cron";
import Schedules from "./views/Schedules";
import AgentDetail from "./views/AgentDetail";
import CommandCenter from "./views/CommandCenter";

function AgentsView() {
  const { agents, loading, error, live } = useAgents();

  const stats = useMemo(() => {
    const by = (s: AgentStatus) => agents.filter((a) => a.status === s).length;
    return {
      total: agents.length,
      live: agents.filter((a) => a.live).length,
      working: by("working"),
      failed: by("failed"),
    };
  }, [agents]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-3xl font-extrabold tracking-tight">
            <IrisMark size={30} /> ARG<span className="text-eye">U</span>S
          </h1>
          <p className="mt-1 text-sm text-ink-dim">
            The all-seeing monitor for your Claude Code agents
          </p>
        </div>
        <ConnectionPill live={live} />
      </header>

      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <HealthCounter label="Agents" value={stats.total} />
        <HealthCounter label="Live" value={stats.live} tone="live" />
        <HealthCounter label="Working" value={stats.working} tone="run" />
        <HealthCounter label="Failed" value={stats.failed} tone="fail" />
      </section>

      {error && (
        <div className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail">
          Couldn't reach the Argus server: {error}
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading agents…</p>
      ) : agents.length === 0 ? (
        <EmptyState>No background agents found yet. Launch one and it'll appear here.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {agents.map((a) => (
            <a key={a.short} href={`#/agent/${encodeURIComponent(a.short)}`} className="block">
              <AgentTile agent={a} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

type TabGroup = "primary" | "monitoring" | "hidden";

const TABS: { id: string; label: string; group: TabGroup; render: () => React.ReactNode }[] = [
  { id: "command", label: "Command Center", group: "primary", render: () => <CommandCenter /> },
  { id: "schedules", label: "Scheduler", group: "primary", render: () => <Schedules /> },
  { id: "agents", label: "Agents", group: "monitoring", render: () => <AgentsView /> },
  { id: "sessions", label: "Sessions", group: "monitoring", render: () => <Sessions /> },
  { id: "activity", label: "Activity", group: "monitoring", render: () => <ActivityFeed /> },
  { id: "projects", label: "Projects", group: "monitoring", render: () => <Projects /> },
  { id: "search", label: "Search", group: "monitoring", render: () => <Search /> },
  { id: "stats", label: "Stats", group: "monitoring", render: () => <Stats /> },
  { id: "inventory", label: "Inventory", group: "monitoring", render: () => <Inventory /> },
  { id: "tasks", label: "Tasks", group: "monitoring", render: () => <Tasks /> },
  { id: "cron", label: "Cron", group: "monitoring", render: () => <Cron /> },
  { id: "agent", label: "Detail", group: "hidden", render: () => <AgentDetail /> },
];

function currentTabId(): string {
  return window.location.hash.replace(/^#\/?/, "").split("/")[0] || "schedules";
}

export default function App() {
  const [active, setActive] = useState<string>(currentTabId);

  useEffect(() => {
    const onHash = () => setActive(currentTabId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const tab = TABS.find((t) => t.id === active) ?? TABS.find((t) => t.id === "schedules")!;
  const primaryTabs = TABS.filter((t) => t.group === "primary");
  const monitoringTabs = TABS.filter((t) => t.group === "monitoring");

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-10 border-b border-line bg-ground/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex items-center gap-3 overflow-x-auto py-2">
            <span className="flex shrink-0 items-center gap-2 text-sm font-bold">
              <IrisMark size={18} /> ARG<span className="text-eye">U</span>S
            </span>
            <span className="hidden shrink-0 text-xs text-ink-faint sm:inline">
              — schedule &amp; monitor Claude agents
            </span>
            <div className="ml-2 flex items-center gap-1">
              {primaryTabs.map((t) => (
                <a
                  key={t.id}
                  href={`#/${t.id}`}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    t.id === tab.id
                      ? "bg-surface-2 text-ink"
                      : "text-ink-dim hover:text-ink"
                  }`}
                >
                  {t.label}
                </a>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1 overflow-x-auto border-t border-line py-1.5">
            {monitoringTabs.map((t) => (
              <a
                key={t.id}
                href={`#/${t.id}`}
                className={`shrink-0 rounded-md px-2.5 py-1 text-xs transition ${
                  t.id === tab.id
                    ? "bg-surface-2 text-ink"
                    : "text-ink-faint hover:text-ink-dim"
                }`}
              >
                {t.label}
              </a>
            ))}
          </div>
        </div>
      </nav>
      <main>{tab.render()}</main>
    </div>
  );
}
