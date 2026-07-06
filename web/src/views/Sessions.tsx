import {
  useSession,
  useSessions,
  type SessionMessage,
  type SessionSummary,
} from "../useSessions";
import { useHashRoute } from "../useHashRoute";
import { AlertStrip, EmptyState, Page } from "../ds";

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

function sessionHref(project: string, id: string): string {
  return `#/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
}

function SessionCard({ session }: { session: SessionSummary }) {
  return (
    <a
      href={sessionHref(session.project, session.id)}
      className="block rounded-xl border border-line bg-surface p-4 text-left transition hover:border-ink-faint/40 hover:bg-surface-2"
    >
      <h3 className="line-clamp-2 text-base font-semibold text-ink">
        {session.title}
      </h3>
      <p className="mt-1 truncate font-mono text-xs text-ink-faint">
        {session.projectLabel}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
        <span className="text-ink-dim">{session.messageCount} msgs</span>
        <span>· {session.toolUseCount} tools</span>
        {session.model && (
          <span className="rounded-full bg-queue/12 px-2 py-0.5 text-queue ring-1 ring-queue/30">
            {session.model}
          </span>
        )}
        <span className="ml-auto">{timeAgo(session.lastActivity)}</span>
      </div>
    </a>
  );
}

const ROLE_STYLE: Record<string, string> = {
  user: "bg-queue/12 text-queue ring-queue/30",
  assistant: "bg-ok/12 text-ok ring-ok/20",
};

function MessageRow({ message }: { message: SessionMessage }) {
  const role = message.role ?? message.type;
  const pill = ROLE_STYLE[role] ?? "bg-idle/12 text-idle ring-idle/30";
  return (
    <article className="rounded-xl border border-line bg-surface p-4">
      <header className="flex items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-medium uppercase tracking-wide ring-1 ${pill}`}
        >
          {role}
        </span>
        {message.toolName && (
          <span className="rounded-full bg-run/12 px-2 py-0.5 font-mono text-run ring-1 ring-run/30">
            {message.toolName}
          </span>
        )}
        {message.isError && (
          <span className="rounded-full bg-fail/12 px-2 py-0.5 text-fail ring-1 ring-fail/30">
            error
          </span>
        )}
        <span className="ml-auto text-ink-faint">{timeAgo(message.timestamp)}</span>
      </header>
      {message.text && (
        <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm text-ink-dim">
          {message.text}
        </pre>
      )}
    </article>
  );
}

function SessionTranscript({ project, id }: { project: string; id: string }) {
  const { session: detail, loading, error } = useSession(project, id);

  const toolUses = detail?.messages.filter((m) => m.toolName).length ?? 0;
  return (
    <Page
      title={detail?.title ?? "Transcript"}
      crumbs={[
        { label: "Command Center", href: "#/command" },
        { label: "Sessions", href: "#/sessions" },
      ]}
      actions={
        detail ? (
          <a
            href={`/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}/export`}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-dim transition hover:border-ink-faint/40 hover:text-ink"
          >
            ↓ Export Markdown
          </a>
        ) : null
      }
    >
      <a
        href="#/sessions"
        className="mb-6 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-dim transition hover:border-ink-faint/40 hover:text-ink"
      >
        ← Back to sessions
      </a>
      {detail && (
        <div className="mb-6">
          <p className="truncate font-mono text-xs text-ink-faint">{detail.projectLabel}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
            <span>{detail.messages.length} msgs</span>
            <span>· {toolUses} tools</span>
            {detail.model && <span>· {detail.model}</span>}
            <span>· last activity {timeAgo(detail.lastActivity)}</span>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't load transcript: ${error}`} />
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading transcript…</p>
      ) : !detail || detail.messages.length === 0 ? (
        <EmptyState>No displayable messages in this session.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {detail.messages.map((m) => (
            <MessageRow key={m.index} message={m} />
          ))}
        </div>
      )}
    </Page>
  );
}

export default function Sessions() {
  const { sessions, loading, error } = useSessions();
  const segments = useHashRoute();

  // Deep-linkable transcript: #/sessions/:project/:id renders the transcript
  // directly, so a reload or a shared link lands on the same view.
  if (segments[0] === "sessions" && segments[1] && segments[2]) {
    return <SessionTranscript project={segments[1]} id={segments[2]} />;
  }

  return (
    <Page title="Sessions" crumbs={[{ label: "Command Center", href: "#/command" }]}>
      <p className="mb-6 text-sm text-ink-faint">
        Recent Claude Code transcripts across all projects
      </p>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't reach the Argus server: ${error}`} />
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading sessions…</p>
      ) : sessions.length === 0 ? (
        <EmptyState>No sessions found yet.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {sessions.map((s) => (
            <SessionCard key={`${s.project}/${s.id}`} session={s} />
          ))}
        </div>
      )}
    </Page>
  );
}
