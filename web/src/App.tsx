import { useEffect, useMemo, useState } from "react";
import { useAgents } from "./useAgents";
import type { Agent, AgentStatus } from "./types";
import { AgentTile, HealthCounter, EmptyState, Page } from "./ds";
import { NavBar } from "./NavBar";
import type { NavTab } from "./NavBar";
import type { MoreItem } from "./ds";
import Sessions from "./views/Sessions";
import ActivityFeed from "./views/ActivityFeed";
import Projects from "./views/Projects";
import Stats from "./views/Stats";
import Inventory from "./views/Inventory";
import Tasks from "./views/Tasks";
import Search from "./views/Search";
import Schedules from "./views/Schedules";
import AgentDetail from "./views/AgentDetail";
import CommandCenter from "./views/CommandCenter";

function AgentsView({
  agents,
  loading,
  error,
}: {
  agents: Agent[];
  loading: boolean;
  error: string | null;
}) {
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
    <Page title="Agents" crumbs={[{ label: "Command Center", href: "#/command" }]}>
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
    </Page>
  );
}

type TabRole = "destination" | "utility" | "overflow" | "drilldown";

const TAB_META: { id: string; label: string; role: TabRole }[] = [
  { id: "command", label: "Command Center", role: "destination" },
  { id: "schedules", label: "Scheduler", role: "destination" },
  { id: "search", label: "Search", role: "utility" },
  { id: "stats", label: "Stats", role: "overflow" },
  { id: "inventory", label: "Inventory", role: "overflow" },
  { id: "projects", label: "Projects", role: "overflow" },
  { id: "tasks", label: "Tasks", role: "overflow" },
  { id: "agents", label: "Agents", role: "drilldown" },
  { id: "sessions", label: "Sessions", role: "drilldown" },
  { id: "activity", label: "Activity", role: "drilldown" },
  { id: "agent", label: "Detail", role: "drilldown" },
];

function currentTabId(): string {
  return window.location.hash.replace(/^#\/?/, "").split("/")[0] || "command";
}

export default function App() {
  const [active, setActive] = useState<string>(currentTabId);
  const agentsState = useAgents();

  useEffect(() => {
    const onHash = () => setActive(currentTabId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const destinations: NavTab[] = TAB_META.filter((t) => t.role === "destination").map((t) => ({
    id: t.id,
    label: t.label,
  }));
  const overflow: MoreItem[] = TAB_META.filter((t) => t.role === "overflow").map((t) => ({
    id: t.id,
    label: t.label,
    href: `#/${t.id}`,
  }));

  const renderActive = () => {
    switch (active) {
      case "schedules":
        return <Schedules />;
      case "search":
        return <Search />;
      case "stats":
        return <Stats />;
      case "inventory":
        return <Inventory />;
      case "projects":
        return <Projects />;
      case "tasks":
        return <Tasks />;
      case "agents":
        return (
          <AgentsView
            agents={agentsState.agents}
            loading={agentsState.loading}
            error={agentsState.error}
          />
        );
      case "sessions":
        return <Sessions />;
      case "activity":
        return <ActivityFeed />;
      case "agent":
        return <AgentDetail />;
      case "command":
      default:
        return <CommandCenter />;
    }
  };

  return (
    <div className="min-h-screen">
      <NavBar
        destinations={destinations}
        overflow={overflow}
        activeId={active}
        live={agentsState.live}
      />
      <main>{renderActive()}</main>
    </div>
  );
}
