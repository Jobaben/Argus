import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAgents } from "../useAgents";
import { useTimeline } from "../useTimeline";
import type { Agent, AgentStatus, TimelineEntry } from "../types";
import {
  AlertStrip,
  Button,
  ButtonLink,
  EmptyState,
  Handoff,
  Icon,
  Page,
  RAIL,
  SkeletonRows,
  SkeletonTile,
  STATUS,
  StatusPill,
  SweepBar,
  TILE_DETAIL,
  TILE_SKIN,
  TimeAgo,
  toDsStatus,
  transitionName,
} from "../ds";

/** The timeline's rail dot. The dot carries the colour; the word beside it is
 *  set in ink, so a state is said once in colour and once in words rather than
 *  twice in colour (dot and pill) as it was. */
const DOT_STYLE: Record<AgentStatus, string> = {
  working: "bg-run",
  done: "bg-ok",
  failed: "bg-fail",
  idle: "bg-idle",
  queued: "bg-queue",
  stopped: "bg-idle",
  unknown: "bg-idle",
};

/** Reads the agent short from `#/agent/<short>` and tracks hashchange. */
function useHashShort(): string | null {
  const read = () => {
    const m = location.hash.match(/^#\/agent\/([^/?]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const [short, setShort] = useState<string | null>(read);
  useEffect(() => {
    const onChange = () => setShort(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return short;
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-3 py-2.5">
      <dt className="text-caption text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-small text-ink-dim">{children}</dd>
    </div>
  );
}

/** Status, id and freshness — the line under the agent's name. */
function AgentCaption({ agent }: { agent: Agent }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-caption text-ink-faint">
      <StatusPill status={toDsStatus(agent.status)} />
      <span>
        job <span className="font-mono text-ink-dim">{agent.short}</span>
      </span>
      {/* Live is the brand's cyan everywhere else — the tile, the connection
          pill — and was green here, which on this page also means "done". */}
      {agent.live && (
        <span className="inline-flex items-center gap-1.5 text-eye">
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full rounded-full bg-eye opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-eye" />
          </span>
          Live
        </span>
      )}
      <span>
        Updated <TimeAgo iso={agent.updatedAt} />
      </span>
    </span>
  );
}

/**
 * What the agent is doing, or did — the one sentence worth reading — on the
 * same status-skinned surface as its tile, so the tile you opened and the page
 * you landed on are visibly the same thing.
 */
function AgentSummary({ agent }: { agent: Agent }) {
  const ds = toDsStatus(agent.status);
  const { token } = STATUS[ds];
  const result = agent.result && agent.result !== agent.detail ? agent.result : null;
  if (!agent.detail && !result && ds !== "working") return null;
  return (
    <section
      className={`relative overflow-hidden rounded-tile border bg-gradient-to-b to-surface p-4 pl-5 shadow-raised sm:p-5 sm:pl-6 ${TILE_SKIN[token]}`}
    >
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${RAIL[token]}`} />
      <h2 className="eyebrow">Latest update</h2>
      {agent.detail && (
        <p className={`mt-2 text-body ${TILE_DETAIL[token] ?? "text-ink"}`}>{agent.detail}</p>
      )}
      {ds === "working" && (
        <div className="mt-3">
          <SweepBar />
        </div>
      )}
      {result && (
        <div className="mt-4 rounded-control border border-ok/25 bg-ok/[0.06] px-3.5 py-3">
          <p className="flex items-center gap-1.5 text-caption font-semibold text-ok">
            <Icon name="check-circle" size={14} />
            Result
          </p>
          <p className="mt-1 break-words text-small text-ink-dim">{result}</p>
        </div>
      )}
    </section>
  );
}

/** Everything else the roster knows, as a definition list beside the story. */
function AgentFacts({ agent }: { agent: Agent }) {
  return (
    <aside
      aria-label="Agent details"
      className="rounded-tile border border-line bg-surface px-4 pb-1.5 pt-4 shadow-raised"
    >
      <h2 className="eyebrow">Details</h2>
      <dl className="mt-1 divide-y divide-line">
        {/* One row for the working directory: the folder it used to repeat
            above it is the last segment of this path. */}
        {agent.cwd && (
          <MetaRow label="Working directory">
            <span className="break-all font-mono text-caption">{agent.cwd}</span>
          </MetaRow>
        )}
        {agent.template && <MetaRow label="Template">{agent.template}</MetaRow>}
        {agent.tempo && <MetaRow label="Tempo">{agent.tempo}</MetaRow>}
        {agent.inFlight && (
          <MetaRow label="In flight">
            {agent.inFlight.tasks} tasks · {agent.inFlight.queued} queued
          </MetaRow>
        )}
        {agent.sessionId && (
          <MetaRow label="Session">
            <span className="break-all font-mono text-caption">{agent.sessionId}</span>
          </MetaRow>
        )}
        {agent.cliVersion && (
          <MetaRow label="CLI">
            <span className="font-mono text-caption">{agent.cliVersion}</span>
          </MetaRow>
        )}
        {agent.pid != null && (
          <MetaRow label="PID">
            <span className="font-mono text-caption">{agent.pid}</span>
          </MetaRow>
        )}
        <MetaRow label="Created">
          <TimeAgo iso={agent.createdAt} />
        </MetaRow>
        <MetaRow label="Updated">
          <TimeAgo iso={agent.updatedAt} />
        </MetaRow>
        {agent.firstTerminalAt && (
          <MetaRow label="First terminal">
            <TimeAgo iso={agent.firstTerminalAt} />
          </MetaRow>
        )}
      </dl>
    </aside>
  );
}

function TimelineItem({ entry, last }: { entry: TimelineEntry; last: boolean }) {
  const [open, setOpen] = useState(false);
  const state = entry.state ?? "unknown";
  const hasText = !!entry.text && entry.text.trim().length > 0;

  return (
    <li className="relative pl-7">
      {!last && (
        <span aria-hidden="true" className="absolute bottom-0 left-[5px] top-4 w-px bg-line" />
      )}
      <span
        aria-hidden="true"
        className={`absolute left-0 top-[5px] h-[11px] w-[11px] rounded-full ring-4 ring-surface ${DOT_STYLE[state] ?? DOT_STYLE.unknown}`}
      />
      <div className={last ? "" : "pb-5"}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-small font-semibold text-ink">
            {STATUS[toDsStatus(state)].label}
          </span>
          <span className="text-caption">
            <TimeAgo iso={entry.at} />
          </span>
        </div>
        {entry.detail && <p className="mt-1 text-small text-ink-dim">{entry.detail}</p>}
        {hasText && (
          <div className="mt-1.5">
            <Button
              variant="ghost"
              size="sm"
              iconRight={open ? "chevron-up" : "chevron-down"}
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="-ml-2.5"
            >
              {open ? "Hide details" : "Show details"}
            </Button>
            {open && (
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-ground-2/60 p-3 font-mono text-caption leading-relaxed text-ink-dim">
                {entry.text}
              </pre>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export default function AgentDetail({ short: shortProp }: { short?: string } = {}) {
  const hashShort = useHashShort();
  const short = shortProp ?? hashShort;

  const {
    agents,
    loading: agentsLoading,
    error: agentsError,
    refresh: refreshAgents,
  } = useAgents();
  const { timeline, loading: timelineLoading, error, refresh } = useTimeline(short);

  const agent = useMemo(
    () => (short ? (agents.find((a) => a.short === short) ?? null) : null),
    [agents, short],
  );

  const ordered = useMemo(
    () => [...timeline].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
    [timeline],
  );

  if (!short) {
    return (
      <Page title="Agent" crumbs={[{ label: "Command Center", href: "#/command" }]}>
        <EmptyState
          title="No agent selected"
          icon="user"
          action={
            <ButtonLink href="#/agents" iconRight="arrow-right">
              Open Agents
            </ButtonLink>
          }
        >
          Pick an agent from the roster to see what it is doing and how it got there.
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page
      // The agent's name, when the roster knows it: the page used to say
      // "agent 7a1b" in its heading and the name again in a second heading
      // below it, two titles for one thing.
      title={agent?.name ?? `Agent ${short}`}
      subtitle={
        agent ? (
          <AgentCaption agent={agent} />
        ) : (
          <span className="text-caption text-ink-faint">
            job <span className="font-mono text-ink-dim">{short}</span>
          </span>
        )
      }
      // Pairs with the agent tile on `#/agents`: the tile you clicked morphs into
      // this heading rather than the two views crossfading past each other.
      anchor={transitionName("agent", short)}
      crumbs={[
        { label: "Command Center", href: "#/command" },
        { label: "Agents", href: "#/agents" },
      ]}
    >
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Couldn't load the timeline"
            message={error}
            action={
              <Button size="sm" icon="retry" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      <div
        className={`grid items-start gap-6 ${agent ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]" : ""}`}
      >
        <div className="min-w-0 space-y-6">
          {agent ? (
            <AgentSummary agent={agent} />
          ) : agentsError ? (
            // A roster that failed to load says nothing about this agent:
            // "Unknown agent" under it would be a claim about the data.
            <AlertStrip
              subject="Couldn't load the agent"
              message={agentsError}
              action={
                <Button size="sm" icon="retry" onClick={() => void refreshAgents()}>
                  Retry
                </Button>
              }
            />
          ) : (
            <Handoff busy={agentsLoading} label="the agent" skeleton={<SkeletonTile lines={3} />}>
              <div className="flex items-start gap-3 rounded-tile border border-line bg-surface p-4 shadow-raised">
                <Icon name="info" size={18} className="mt-0.5 text-ink-faint" />
                <div className="min-w-0">
                  <h2 className="text-heading font-semibold text-ink">Unknown agent</h2>
                  <p className="mt-1 text-small text-ink-dim">
                    No matching agent metadata for{" "}
                    <span className="font-mono text-ink">{short}</span> — showing its timeline below
                    if any exists.
                  </p>
                </div>
              </div>
            </Handoff>
          )}

          <section aria-label="Timeline">
            <div className="mb-3 flex min-h-6 items-center justify-between gap-3">
              <h2 className="eyebrow">Timeline</h2>
              {ordered.length > 0 && (
                <span className="text-caption text-ink-faint">
                  {ordered.length} {ordered.length === 1 ? "entry" : "entries"} · newest first
                </span>
              )}
            </div>
            <Handoff
              busy={timelineLoading}
              label="the timeline"
              skeleton={<SkeletonRows count={4} />}
            >
              {ordered.length === 0 ? (
                // A failed load is said once, by the strip above — not again as
                // an empty timeline, which would claim there is nothing to show.
                error ? null : (
                  <EmptyState compact icon="history" title="No timeline yet">
                    No timeline entries recorded for this agent yet.
                  </EmptyState>
                )
              ) : (
                <ol className="rounded-tile border border-line bg-surface px-4 py-4 shadow-raised sm:px-5">
                  {ordered.map((entry, i) => (
                    <TimelineItem
                      key={`${entry.at}-${i}`}
                      entry={entry}
                      last={i === ordered.length - 1}
                    />
                  ))}
                </ol>
              )}
            </Handoff>
          </section>
        </div>

        {agent && <AgentFacts agent={agent} />}
      </div>
    </Page>
  );
}
