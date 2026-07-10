import { useEffect, useMemo, useState } from "react";
import { useAgents } from "./useAgents";
import type { Agent, AgentStatus } from "./types";
import { AgentTile, HealthCounter, EmptyState, Page, ToastRegion } from "./ds";
import { useAgentNotifications } from "./notify/useAgentNotifications";
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
import Chronicle from "./views/Chronicle";
import Pipelines from "./views/Pipelines";
import SetupBanner from "./views/SetupBanner";
import Users from "./views/Users";
import { useAuth } from "./useAuth";

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
  { id: "chronicle", label: "Chronicle", role: "destination" },
  { id: "schedules", label: "Scheduler", role: "destination" },
  { id: "pipelines", label: "Pipelines", role: "destination" },
  { id: "search", label: "Search", role: "utility" },
  { id: "stats", label: "Stats", role: "overflow" },
  { id: "inventory", label: "Inventory", role: "overflow" },
  { id: "projects", label: "Projects", role: "overflow" },
  { id: "tasks", label: "Tasks", role: "overflow" },
  { id: "users", label: "Users", role: "overflow" },
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
  const auth = useAuth();
  const { toasts, dismiss } = useAgentNotifications(agentsState.agents);

  useEffect(() => {
    const onHash = () => setActive(currentTabId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const label = TAB_META.find((t) => t.id === active)?.label ?? "Command Center";
    document.title = `${label} — Argus`;
  }, [active]);

  const destinations: NavTab[] = TAB_META.filter((t) => t.role === "destination").map((t) => ({
    id: t.id,
    label: t.label,
  }));
  const overflow: MoreItem[] = TAB_META.filter(
    (t) => t.role === "overflow" && (t.id !== "users" || auth.status?.role === "root"),
  ).map((t) => ({
    id: t.id,
    label: t.label,
    href: `#/${t.id}`,
  }));

  const renderActive = () => {
    switch (active) {
      case "chronicle":
        return <Chronicle />;
      case "schedules":
        return <Schedules />;
      case "pipelines":
        return <Pipelines />;
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
      case "users":
        return <Users />;
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
      {/* A plain fragment href would be swallowed by the hash router, so the
          skip link moves focus itself. */}
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only rounded-md bg-surface-2 px-3 py-2 text-sm text-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to content
      </a>
      <NavBar
        destinations={destinations}
        overflow={overflow}
        activeId={active}
        live={agentsState.live}
      />
      <SetupBanner />
      <main id="main" tabIndex={-1} className="outline-none">
        {renderActive()}
      </main>
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
