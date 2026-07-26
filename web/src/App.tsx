import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useAgents } from "./useAgents";
import type { Agent, AgentStatus } from "./types";
import {
  AgentTile,
  EmptyState,
  ErrorBoundary,
  HealthCounter,
  Loading,
  Page,
  SkeletonGrid,
  ToastRegion,
  staggerDelay,
} from "./ds";
import { useAgentNotifications } from "./notify/useAgentNotifications";
import { useBudgetAlerts } from "./notify/useBudgetAlerts";
import { useMonitorAlerts } from "./notify/useMonitorAlerts";
import { NavBar } from "./NavBar";
import type { NavTab } from "./NavBar";
import type { MoreItem } from "./ds";
import CommandCenter from "./views/CommandCenter";
import SetupBanner from "./views/SetupBanner";

/**
 * Every view except the landing one is a separate chunk.
 *
 * The whole app used to ship as one 374 KB bundle: opening the Command Center
 * downloaded and parsed the Chronicle's timeline maths, the pipeline editor, the
 * stats charts and the transcript reader, none of which most sessions ever look
 * at. The Command Center stays eager because it *is* the first paint — lazy
 * would trade a smaller bundle for a slower landing, which is the wrong way
 * round.
 *
 * Chunks are fetched on navigation, and the Suspense fallback below is the same
 * skeleton language the views use, so a cold jump to a tab looks like loading
 * rather than like nothing happening.
 */
const Briefing = lazy(() => import("./views/Briefing"));
const Chronicle = lazy(() => import("./views/Chronicle"));
const Launch = lazy(() => import("./views/Launch"));
const Schedules = lazy(() => import("./views/Schedules"));
const Monitors = lazy(() => import("./views/Monitors"));
const Issues = lazy(() => import("./views/Issues"));
const Pipelines = lazy(() => import("./views/Pipelines"));
const Budget = lazy(() => import("./views/Budget"));
const Search = lazy(() => import("./views/Search"));
const Stats = lazy(() => import("./views/Stats"));
const Inventory = lazy(() => import("./views/Inventory"));
const Projects = lazy(() => import("./views/Projects"));
const Tasks = lazy(() => import("./views/Tasks"));
const Users = lazy(() => import("./views/Users"));
const Sessions = lazy(() => import("./views/Sessions"));
const ActivityFeed = lazy(() => import("./views/ActivityFeed"));
const AgentDetail = lazy(() => import("./views/AgentDetail"));
import { useBriefing } from "./useBriefing";
import { useAuth } from "./useAuth";
import {
  CommandPalette,
  NAV_CHORDS,
  ShortcutHelp,
  useGlobalKeys,
  usePalette,
  usePaletteState,
  useShellBindings,
} from "./cmd";

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
        <Loading label="agents">
          <SkeletonGrid count={4} columns={2} lines={2} />
        </Loading>
      ) : agents.length === 0 ? (
        <EmptyState>No background agents found yet. Launch one and it'll appear here.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {agents.map((a, i) => (
            <a
              key={a.short}
              href={`#/agent/${encodeURIComponent(a.short)}`}
              style={{ animationDelay: staggerDelay(i) }}
              className="block rounded-tile transition-transform duration-(--duration-quick) hover:-translate-y-0.5 motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]"
            >
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
  { id: "briefing", label: "Briefing", role: "destination" },
  { id: "chronicle", label: "Chronicle", role: "destination" },
  { id: "launch", label: "Launch", role: "destination" },
  { id: "schedules", label: "Scheduler", role: "destination" },
  { id: "monitors", label: "Monitors", role: "destination" },
  { id: "issues", label: "Issues", role: "destination" },
  { id: "pipelines", label: "Pipelines", role: "destination" },
  { id: "budget", label: "Budget", role: "destination" },
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

/** The Suspense fallback for a route whose chunk is still downloading. Shaped
 *  like a page, so the layout does not jump when the real view arrives. */
function ViewLoading({ label }: { label: string }) {
  return (
    <Page title={label}>
      <Loading label={label}>
        <SkeletonGrid count={4} columns={2} lines={3} />
      </Loading>
    </Page>
  );
}

function currentTabId(): string {
  return window.location.hash.replace(/^#\/?/, "").split("/")[0] || "command";
}

/**
 * POSTs a palette action and throws the server's own error message, so the
 * palette can report "an instance is already running" rather than "HTTP 409".
 */
async function postAction(path: string): Promise<void> {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export default function App() {
  const [active, setActive] = useState<string>(currentTabId);
  const agentsState = useAgents();
  const auth = useAuth();
  const briefingState = useBriefing();
  const palette = usePaletteState();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const agentToasts = useAgentNotifications(agentsState.agents);
  const monitorToasts = useMonitorAlerts();
  const budgetToasts = useBudgetAlerts();
  // One region, three sources. Ids are unique per queue and dismissing an
  // unknown id is a no-op, so routing a dismiss to every queue is safe.
  const toasts = [...agentToasts.toasts, ...monitorToasts.toasts, ...budgetToasts.toasts];
  const dismiss = (id: string) => {
    agentToasts.dismiss(id);
    monitorToasts.dismiss(id);
    budgetToasts.dismiss(id);
  };

  useEffect(() => {
    const onHash = () => setActive(currentTabId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const activeLabel = useMemo(
    () => TAB_META.find((t) => t.id === active)?.label ?? "Command Center",
    [active],
  );

  useEffect(() => {
    document.title = `${activeLabel} — Argus`;
  }, [activeLabel]);

  const destinations: NavTab[] = useMemo(
    () =>
      TAB_META.filter((t) => t.role === "destination").map((t) => ({
        id: t.id,
        label: t.label,
        badge: t.id === "briefing" ? (briefingState.briefing?.attentionCount ?? 0) : undefined,
      })),
    [briefingState.briefing?.attentionCount],
  );
  const overflow: MoreItem[] = TAB_META.filter(
    (t) => t.role === "overflow" && (t.id !== "users" || auth.status?.role === "root"),
  ).map((t) => ({
    id: t.id,
    label: t.label,
    href: `#/${t.id}`,
  }));

  // ── The command layer ─────────────────────────────────────────────────────
  // Everything reachable by mouse is reachable by keyboard through these two
  // surfaces, and both are built from the same nav metadata as the bar itself.

  const closeOverlays = useCallback(() => {
    palette.hide();
    setShortcutsOpen(false);
  }, [palette]);

  const shellActions = useMemo(
    () => ({
      openPalette: palette.show,
      openShortcuts: () => setShortcutsOpen(true),
      closeOverlays,
      overlayOpen: () => palette.open || shortcutsOpen,
      navigate: (tabId: string) => {
        window.location.hash = `#/${tabId}`;
      },
    }),
    [palette.show, palette.open, shortcutsOpen, closeOverlays],
  );

  // Palette entries are the same destinations, annotated with the chord that
  // also reaches them — so the palette teaches its own shortcuts.
  const paletteDestinations = useMemo(
    () =>
      TAB_META.filter((t) => t.role === "destination" || t.role === "overflow" || t.id === "search")
        .filter((t) => t.id !== "users" || auth.status?.role === "root")
        .map((t) => ({
          id: t.id,
          label: t.label,
          chord: NAV_CHORDS[t.id] ? `g ${NAV_CHORDS[t.id]}` : undefined,
        })),
    [auth.status?.role],
  );

  // Chord targets are not the same set as nav destinations: Agents is a
  // drill-down with no tab of its own, but `g a` should still reach it.
  const chordTargets = useMemo(
    () => TAB_META.filter((t) => NAV_CHORDS[t.id]).map((t) => ({ id: t.id, label: t.label })),
    [],
  );
  const bindings = useShellBindings(chordTargets, shellActions);
  useGlobalKeys(bindings);

  const paletteCtx = useMemo(
    () => ({
      destinations: paletteDestinations,
      canAdmin: auth.status?.authenticated === true,
      approveGate: (instanceId: string) => postAction(`/api/instances/${instanceId}/approve`),
      runSchedule: (scheduleId: string) => postAction(`/api/schedules/${scheduleId}/run`),
      markCaughtUp: async () => {
        await briefingState.ack();
      },
      showShortcuts: () => setShortcutsOpen(true),
    }),
    [paletteDestinations, auth.status?.authenticated, briefingState],
  );
  const { commands, loading: paletteLoading } = usePalette(palette.open, paletteCtx);

  const renderActive = () => {
    switch (active) {
      case "briefing":
        return (
          <Briefing
            briefing={briefingState.briefing}
            loading={briefingState.loading}
            error={briefingState.error}
            ack={briefingState.ack}
          />
        );
      case "chronicle":
        return <Chronicle />;
      case "launch":
        return <Launch />;
      case "schedules":
        return <Schedules />;
      case "monitors":
        return <Monitors />;
      case "issues":
        return <Issues />;
      case "pipelines":
        return <Pipelines />;
      case "budget":
        return <Budget />;
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
        onOpenPalette={palette.show}
      />
      <SetupBanner />
      <main id="main" tabIndex={-1} className="outline-none">
        {/* Keyed on the route so switching destinations reads as a deliberate
            transition rather than a flicker. Opacity only — a moving page would
            fight the staggered content inside it. */}
        <div key={active} className="motion-safe:animate-[fade-in_var(--duration-base)_ease-out]">
          {/* Scoped per route: a bad shape in one view costs that view, not the
              nav, the palette and every other tab. */}
          <ErrorBoundary label={activeLabel} resetKey={active}>
            <Suspense fallback={<ViewLoading label={activeLabel} />}>{renderActive()}</Suspense>
          </ErrorBoundary>
        </div>
      </main>
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
      <CommandPalette
        open={palette.open}
        onClose={palette.hide}
        commands={commands}
        loading={paletteLoading}
      />
      <ShortcutHelp
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        bindings={bindings}
      />
    </div>
  );
}
