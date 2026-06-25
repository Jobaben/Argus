import { useEffect, useMemo, useState } from "react";
import { useAgents } from "./useAgents";
import type { Agent, AgentStatus } from "./types";
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

const STATUS_STYLE: Record<AgentStatus, string> = {
  working: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  done: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  idle: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  queued: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  stopped: "bg-zinc-600/20 text-zinc-300 ring-zinc-500/30",
  unknown: "bg-slate-500/15 text-slate-400 ring-slate-500/30",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide ring-1 ${STATUS_STYLE[status] ?? STATUS_STYLE.unknown}`}
    >
      {status}
    </span>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const folder = agent.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;
  return (
    <a
      href={`#/agent/${encodeURIComponent(agent.short)}`}
      className="block rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-white/20 hover:bg-white/[0.05]"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-white">{agent.name}</h3>
          <p className="mt-0.5 font-mono text-xs text-white/40">{agent.short}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusPill status={agent.status} />
          {agent.live && (
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              live
            </span>
          )}
        </div>
      </header>

      {agent.detail && (
        <p className="mt-3 line-clamp-3 text-sm text-white/70">{agent.detail}</p>
      )}

      {agent.result && agent.result !== agent.detail && (
        <p className="mt-2 line-clamp-2 rounded-lg bg-emerald-500/5 px-3 py-2 text-sm text-emerald-200/80">
          {agent.result}
        </p>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/40">
        {folder && <span className="font-mono text-white/55">{folder}</span>}
        {agent.template && <span>· {agent.template}</span>}
        {agent.tempo && <span>· {agent.tempo}</span>}
        {agent.inFlight && agent.inFlight.tasks > 0 && (
          <span className="text-amber-300/80">· {agent.inFlight.tasks} in flight</span>
        )}
        <span className="ml-auto">updated {timeAgo(agent.updatedAt)}</span>
      </footer>
    </a>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2">
      <div className="text-2xl font-semibold text-white">{value}</div>
      <div className="text-xs uppercase tracking-wide text-white/40">{label}</div>
    </div>
  );
}

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
          <h1 className="flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white">
            <span aria-hidden>👁️</span> Argus
          </h1>
          <p className="mt-1 text-sm text-white/45">
            The all-seeing monitor for your Claude Code agents
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ${
            live
              ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30"
              : "bg-slate-500/10 text-slate-400 ring-slate-500/30"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${live ? "bg-emerald-400" : "bg-slate-500"}`} />
          {live ? "live" : "reconnecting…"}
        </span>
      </header>

      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Agents" value={stats.total} />
        <Stat label="Live" value={stats.live} />
        <Stat label="Working" value={stats.working} />
        <Stat label="Failed" value={stats.failed} />
      </section>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t reach the Argus server: {error}
        </div>
      )}

      {loading ? (
        <p className="text-white/40">Loading agents…</p>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No background agents found yet. Launch one and it’ll appear here.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {agents.map((a) => (
            <AgentCard key={a.short} agent={a} />
          ))}
        </div>
      )}
    </div>
  );
}

type TabGroup = "primary" | "monitoring" | "hidden";

const TABS: { id: string; label: string; group: TabGroup; render: () => React.ReactNode }[] = [
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
      <nav className="sticky top-0 z-10 border-b border-white/10 bg-[#0a0b0f]/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex items-center gap-3 overflow-x-auto py-2">
            <span className="shrink-0 text-sm font-semibold text-white">👁️ Argus</span>
            <span className="hidden shrink-0 text-xs text-white/40 sm:inline">
              — schedule &amp; monitor Claude agents
            </span>
            <div className="ml-2 flex items-center gap-1">
              {primaryTabs.map((t) => (
                <a
                  key={t.id}
                  href={`#/${t.id}`}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    t.id === tab.id
                      ? "bg-white/10 text-white"
                      : "text-white/70 hover:text-white"
                  }`}
                >
                  {t.label}
                </a>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1 overflow-x-auto border-t border-white/5 py-1.5">
            {monitoringTabs.map((t) => (
              <a
                key={t.id}
                href={`#/${t.id}`}
                className={`shrink-0 rounded-md px-2.5 py-1 text-xs transition ${
                  t.id === tab.id
                    ? "bg-white/10 text-white"
                    : "text-white/40 hover:text-white/70"
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
