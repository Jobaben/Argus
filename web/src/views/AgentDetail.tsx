import { useEffect, useMemo, useState } from "react";
import { useAgents } from "../useAgents";
import { useTimeline } from "../useTimeline";
import type { Agent, AgentStatus, TimelineEntry } from "../types";
import { AlertStrip, EmptyState, Page, StatusPill, TimeAgo, toDsStatus } from "../ds";

const DOT_STYLE: Record<AgentStatus, string> = {
  working: "bg-run ring-run/30",
  done: "bg-ok ring-ok/30",
  failed: "bg-fail ring-fail/30",
  idle: "bg-idle ring-idle/30",
  queued: "bg-queue ring-queue/30",
  stopped: "bg-idle ring-idle/30",
  unknown: "bg-idle ring-idle/30",
};

function formatAt(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

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

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs uppercase tracking-wide text-ink-faint">{label}</span>
      <span className={`min-w-0 truncate text-right text-sm text-ink-dim ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function AgentMeta({ agent }: { agent: Agent }) {
  const folder = agent.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold text-ink">{agent.name}</h2>
          <p className="mt-0.5 font-mono text-xs text-ink-faint">{agent.short}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusPill status={toDsStatus(agent.status)} />
          {agent.live && (
            <span className="inline-flex items-center gap-1.5 text-xs text-ok">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
              </span>
              live
            </span>
          )}
        </div>
      </header>

      {agent.detail && <p className="mt-3 text-sm text-ink-dim">{agent.detail}</p>}

      {agent.result && agent.result !== agent.detail && (
        <p className="mt-2 rounded-lg bg-ok/5 px-3 py-2 text-sm text-ok">{agent.result}</p>
      )}

      <div className="mt-3 divide-y divide-line/30 border-t border-line/30 pt-1">
        {folder && <MetaRow label="Folder" value={folder} mono />}
        {agent.cwd && <MetaRow label="CWD" value={agent.cwd} mono />}
        {agent.template && <MetaRow label="Template" value={agent.template} />}
        {agent.tempo && <MetaRow label="Tempo" value={agent.tempo} />}
        {agent.sessionId && <MetaRow label="Session" value={agent.sessionId} mono />}
        {agent.cliVersion && <MetaRow label="CLI" value={agent.cliVersion} mono />}
        {agent.pid != null && <MetaRow label="PID" value={String(agent.pid)} mono />}
        {agent.inFlight && (
          <MetaRow
            label="In flight"
            value={`${agent.inFlight.tasks} tasks · ${agent.inFlight.queued} queued`}
          />
        )}
        <div className="flex items-baseline justify-between gap-4 py-1.5">
          <span className="shrink-0 text-xs uppercase tracking-wide text-ink-faint">Created</span>
          <TimeAgo iso={agent.createdAt} />
        </div>
        <div className="flex items-baseline justify-between gap-4 py-1.5">
          <span className="shrink-0 text-xs uppercase tracking-wide text-ink-faint">Updated</span>
          <TimeAgo iso={agent.updatedAt} />
        </div>
        {agent.firstTerminalAt && (
          <div className="flex items-baseline justify-between gap-4 py-1.5">
            <span className="shrink-0 text-xs uppercase tracking-wide text-ink-faint">First terminal</span>
            <TimeAgo iso={agent.firstTerminalAt} />
          </div>
        )}
      </div>
    </section>
  );
}

function TimelineItem({ entry, last }: { entry: TimelineEntry; last: boolean }) {
  const [open, setOpen] = useState(false);
  const state = entry.state ?? "unknown";
  const hasText = !!entry.text && entry.text.trim().length > 0;

  return (
    <li className="relative pl-8">
      {!last && <span className="absolute left-[7px] top-3 h-full w-px bg-line" aria-hidden />}
      <span
        className={`absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full ring-4 ${DOT_STYLE[state] ?? DOT_STYLE.unknown}`}
        aria-hidden
      />
      <div className="pb-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusPill status={toDsStatus(state)} />
          <time className="text-xs text-ink-faint">{formatAt(entry.at)}</time>
        </div>
        {entry.detail && <p className="mt-1.5 text-sm text-ink-dim">{entry.detail}</p>}
        {hasText && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-queue ring-1 ring-queue/30 transition hover:bg-queue/10"
            >
              <span aria-hidden>{open ? "▾" : "▸"}</span>
              {open ? "Hide details" : "Show details"}
            </button>
            {open && (
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-black/30 p-3 text-xs leading-relaxed text-ink-dim">
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

  const { agents, loading: agentsLoading } = useAgents();
  const { timeline, loading: timelineLoading, error } = useTimeline(short);

  const agent = useMemo(
    () => (short ? agents.find((a) => a.short === short) ?? null : null),
    [agents, short],
  );

  const ordered = useMemo(
    () =>
      [...timeline].sort(
        (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
      ),
    [timeline],
  );

  if (!short) {
    return (
      <Page title="Agent" crumbs={[{ label: "Command Center", href: "#/command" }]}>
        <EmptyState>
          No agent selected. Open <span className="font-mono text-ink-dim">#/agent/&lt;short&gt;</span> to view one.
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page
      title={`agent ${short}`}
      crumbs={[
        { label: "Command Center", href: "#/command" },
        { label: "Agents", href: "#/agents" },
      ]}
    >

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't load timeline: ${error}`} />
        </div>
      )}

      {agent ? (
        <AgentMeta agent={agent} />
      ) : agentsLoading ? (
        <p className="text-ink-faint">Loading agent…</p>
      ) : (
        <div className="rounded-xl border border-line bg-surface p-4">
          <h2 className="text-lg font-semibold text-ink">Unknown agent</h2>
          <p className="mt-1 font-mono text-xs text-ink-faint">{short}</p>
          <p className="mt-2 text-sm text-ink-faint">
            No matching agent metadata — showing its timeline below if any exists.
          </p>
        </div>
      )}

      <section className="mt-8">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Timeline
        </h3>
        {timelineLoading ? (
          <p className="text-ink-faint">Loading timeline…</p>
        ) : ordered.length === 0 ? (
          <EmptyState>No timeline entries recorded for this agent yet.</EmptyState>
        ) : (
          <ol className="relative">
            {ordered.map((entry, i) => (
              <TimelineItem
                key={`${entry.at}-${i}`}
                entry={entry}
                last={i === ordered.length - 1}
              />
            ))}
          </ol>
        )}
      </section>
    </Page>
  );
}
