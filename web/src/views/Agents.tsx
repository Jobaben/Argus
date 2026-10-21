import { useMemo } from "react";
import type { Agent, AgentStatus } from "../types";
import {
  AlertStrip,
  Button,
  ButtonLink,
  EmptyState,
  Handoff,
  Page,
  SkeletonGrid,
  staggerDelay,
  transitionName,
  useFlip,
} from "../ds";
import { AgentTile } from "../ds/AgentTile";
import { HealthCounter } from "../ds/HealthCounter";

/**
 * The background agents, as tiles. The list itself is owned by the shell (the
 * nav's live dot and the agent toasts read the same fetch), so it arrives as
 * props; this view is a drill-down, and lazy like every view but the board.
 */
export default function AgentsView({
  agents,
  loading,
  error,
  refresh,
}: {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}) {
  // The fleet re-sorts as agents change status; FLIP glides the tiles to their
  // new places instead of teleporting them.
  const flip = useFlip();
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
    <Page
      title="Agents"
      subtitle="Tasks launched to run in the background: what each is doing now, and how it ended."
      crumbs={[{ label: "Command Center", href: "#/command" }]}
    >
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Agents"
            message={`Couldn't reach the Argus server: ${error}`}
            action={
              <Button size="sm" icon="retry" onClick={() => refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      <Handoff
        busy={loading}
        label="agents"
        skeleton={<SkeletonGrid count={4} columns={2} lines={2} />}
      >
        {agents.length === 0 ? (
          // A failed load is not an empty fleet: the strip above says what
          // happened, and "no agents yet" under it would be a second answer.
          !error && (
            <EmptyState
              icon="bolt"
              title="No background agents yet"
              action={
                <ButtonLink href="#/schedules/oneoff" variant="primary" icon="bolt">
                  Launch a task
                </ButtonLink>
              }
            >
              A task launched to run in the background shows up here while it works, with its status
              and what it is doing.
            </EmptyState>
          )
        ) : (
          <>
            {/* With the tiles, never above an empty state: four zeros over
                "no agents yet" said the same nothing four more times. */}
            <section
              aria-label="Agent counts"
              className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4"
            >
              <HealthCounter label="Agents" value={stats.total} />
              <HealthCounter label="Live" value={stats.live} tone="live" />
              <HealthCounter label="Working" value={stats.working} tone="run" />
              <HealthCounter label="Failed" value={stats.failed} tone="fail" />
            </section>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {agents.map((a, i) => (
                <a
                  key={a.short}
                  href={`#/agent/${encodeURIComponent(a.short)}`}
                  ref={flip(a.short)}
                  // The tile and the detail page's header share a transition name, so
                  // where the browser supports it the tile you clicked visibly
                  // *becomes* the page you land on — the strongest available answer to
                  // "where did this come from". Only one element carries any given
                  // name at a time, which is what makes the pairing legal.
                  style={{
                    animationDelay: staggerDelay(i),
                    viewTransitionName: transitionName("agent", a.short),
                  }}
                  className="block rounded-tile transition-transform duration-(--duration-quick) hover:-translate-y-0.5 motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both] motion-safe:active:translate-y-0 motion-safe:active:scale-[0.99]"
                >
                  <AgentTile agent={a} />
                </a>
              ))}
            </div>
          </>
        )}
      </Handoff>
    </Page>
  );
}
