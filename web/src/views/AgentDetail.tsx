import { useEffect, useMemo, useState } from "react";
import { useAgents } from "../useAgents";
import { useTimeline } from "../useTimeline";
import type { Agent, AgentStatus, TimelineEntry } from "../types";

const STATUS_STYLE: Record<AgentStatus, string> = {
  working: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  done: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  idle: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  queued: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  unknown: "bg-slate-500/15 text-slate-400 ring-slate-500/30",
};

const DOT_STYLE: Record<AgentStatus, string> = {
  working: "bg-amber-400 ring-amber-400/30",
  done: "bg-emerald-400 ring-emerald-400/30",
  failed: "bg-rose-400 ring-rose-400/30",
  idle: "bg-slate-400 ring-slate-400/30",
  queued: "bg-sky-400 ring-sky-400/30",
  unknown: "bg-slate-500 ring-slate-500/30",
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

function formatAt(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide ring-1 ${STATUS_STYLE[status]}`}
    >
      {status}
    </span>
  );
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
      <span className="shrink-0 text-xs uppercase tracking-wide text-white/40">{label}</span>
      <span className={`min-w-0 truncate text-right text-sm text-white/80 ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function AgentMeta({ agent }: { agent: Agent }) {
  const folder = agent.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold text-white">{agent.name}</h2>
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

      {agent.detail && <p className="mt-3 text-sm text-white/70">{agent.detail}</p>}

      {agent.result && agent.result !== agent.detail && (
        <p className="mt-2 rounded-lg bg-emerald-500/5 px-3 py-2 text-sm text-emerald-200/80">
          {agent.result}
        </p>
      )}

      <div className="mt-3 divide-y divide-white/5 border-t border-white/5 pt-1">
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
        <MetaRow label="Created" value={timeAgo(agent.createdAt)} />
        <MetaRow label="Updated" value={timeAgo(agent.updatedAt)} />
        {agent.firstTerminalAt && (
          <MetaRow label="First terminal" value={timeAgo(agent.firstTerminalAt)} />
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
      {!last && <span className="absolute left-[7px] top-3 h-full w-px bg-white/10" aria-hidden />}
      <span
        className={`absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full ring-4 ${DOT_STYLE[state]}`}
        aria-hidden
      />
      <div className="pb-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusPill status={state} />
          <time className="text-xs text-white/40">{formatAt(entry.at)}</time>
        </div>
        {entry.detail && <p className="mt-1.5 text-sm text-white/80">{entry.detail}</p>}
        {hasText && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-sky-300 ring-1 ring-sky-500/30 transition hover:bg-sky-500/10"
            >
              <span aria-hidden>{open ? "▾" : "▸"}</span>
              {open ? "Hide details" : "Show details"}
            </button>
            {open && (
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/30 p-3 text-xs leading-relaxed text-white/70">
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
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No agent selected. Open <span className="font-mono text-white/60">#/agent/&lt;short&gt;</span> to view one.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <a
        href="#/"
        className="mb-4 inline-flex items-center gap-1 text-sm text-white/45 transition hover:text-white/80"
      >
        <span aria-hidden>←</span> All agents
      </a>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t load timeline: {error}
        </div>
      )}

      {agent ? (
        <AgentMeta agent={agent} />
      ) : agentsLoading ? (
        <p className="text-white/40">Loading agent…</p>
      ) : (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="text-lg font-semibold text-white">Unknown agent</h2>
          <p className="mt-1 font-mono text-xs text-white/40">{short}</p>
          <p className="mt-2 text-sm text-white/50">
            No matching agent metadata — showing its timeline below if any exists.
          </p>
        </div>
      )}

      <section className="mt-8">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-white/40">
          Timeline
        </h3>
        {timelineLoading ? (
          <p className="text-white/40">Loading timeline…</p>
        ) : ordered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/15 px-6 py-12 text-center text-white/40">
            No timeline entries recorded for this agent yet.
          </div>
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
    </div>
  );
}
