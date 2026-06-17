import { useState } from "react";
import {
  useSession,
  useSessions,
  type SessionMessage,
  type SessionSummary,
} from "../useSessions";

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

function SessionCard({
  session,
  onOpen,
}: {
  session: SessionSummary;
  onOpen: (s: SessionSummary) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(session)}
      className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left transition hover:border-white/20 hover:bg-white/[0.05]"
    >
      <h3 className="line-clamp-2 text-base font-semibold text-white">
        {session.title}
      </h3>
      <p className="mt-1 truncate font-mono text-xs text-white/40">
        {session.projectLabel}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/45">
        <span className="text-white/55">{session.messageCount} msgs</span>
        <span>· {session.toolUseCount} tools</span>
        {session.model && (
          <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-300 ring-1 ring-sky-500/30">
            {session.model}
          </span>
        )}
        <span className="ml-auto">{timeAgo(session.lastActivity)}</span>
      </div>
    </button>
  );
}

const ROLE_STYLE: Record<string, string> = {
  user: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  assistant: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
};

function MessageRow({ message }: { message: SessionMessage }) {
  const role = message.role ?? message.type;
  const pill = ROLE_STYLE[role] ?? "bg-slate-500/15 text-slate-300 ring-slate-500/30";
  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <header className="flex items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-medium uppercase tracking-wide ring-1 ${pill}`}
        >
          {role}
        </span>
        {message.toolName && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-amber-300 ring-1 ring-amber-500/30">
            {message.toolName}
          </span>
        )}
        {message.isError && (
          <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-rose-300 ring-1 ring-rose-500/30">
            error
          </span>
        )}
        <span className="ml-auto text-white/40">{timeAgo(message.timestamp)}</span>
      </header>
      {message.text && (
        <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm text-white/75">
          {message.text}
        </pre>
      )}
    </article>
  );
}

function SessionTranscript({
  session,
  onBack,
}: {
  session: SessionSummary;
  onBack: () => void;
}) {
  const { session: detail, loading, error } = useSession(
    session.project,
    session.id,
  );

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-6 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white/70 transition hover:border-white/20 hover:text-white"
      >
        ← Back to sessions
      </button>

      <header className="mb-6">
        <h2 className="text-2xl font-bold text-white">{session.title}</h2>
        <p className="mt-1 truncate font-mono text-xs text-white/40">
          {session.projectLabel}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/45">
          <span>{session.messageCount} msgs</span>
          <span>· {session.toolUseCount} tools</span>
          {session.model && <span>· {session.model}</span>}
          <span>· last activity {timeAgo(session.lastActivity)}</span>
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t load transcript: {error}
        </div>
      )}

      {loading ? (
        <p className="text-white/40">Loading transcript…</p>
      ) : !detail || detail.messages.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No displayable messages in this session.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {detail.messages.map((m) => (
            <MessageRow key={m.index} message={m} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sessions() {
  const { sessions, loading, error } = useSessions();
  const [selected, setSelected] = useState<SessionSummary | null>(null);

  if (selected) {
    return (
      <SessionTranscript session={selected} onBack={() => setSelected(null)} />
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-bold text-white">Sessions</h2>
        <p className="mt-1 text-sm text-white/45">
          Recent Claude Code transcripts across all projects
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t reach the Argus server: {error}
        </div>
      )}

      {loading ? (
        <p className="text-white/40">Loading sessions…</p>
      ) : sessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No sessions found yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {sessions.map((s) => (
            <SessionCard
              key={`${s.project}/${s.id}`}
              session={s}
              onOpen={setSelected}
            />
          ))}
        </div>
      )}
    </div>
  );
}
