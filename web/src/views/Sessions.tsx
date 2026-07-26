import { useEffect, useMemo, useRef, useState } from "react";
import { useSessions, type SessionMessage, type SessionSummary } from "../useSessions";
import { useSessionTail } from "../useSessionTail";
import { useHashRoute } from "../useHashRoute";
import { AlertStrip, EmptyState, Loading, Page, SkeletonGrid, SkeletonText, TimeAgo } from "../ds";
import { filterSessions, groupSessionsByDay } from "./sessionList";

function sessionHref(project: string, id: string): string {
  return `#/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
}

function SessionCard({ session }: { session: SessionSummary }) {
  return (
    <a
      href={sessionHref(session.project, session.id)}
      className="block rounded-xl border border-line bg-surface p-4 text-left transition hover:border-ink-faint/40 hover:bg-surface-2"
    >
      <h3 className="line-clamp-2 text-base font-semibold text-ink">{session.title}</h3>
      <p className="mt-1 truncate font-mono text-xs text-ink-faint">{session.projectLabel}</p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
        <span className="text-ink-dim">
          {session.messageCount} {session.messageCount === 1 ? "msg" : "msgs"}
        </span>
        <span>
          · {session.toolUseCount} {session.toolUseCount === 1 ? "tool" : "tools"}
        </span>
        {session.model && (
          <span className="rounded-full bg-queue/12 px-2 py-0.5 text-queue ring-1 ring-queue/30">
            {session.model}
          </span>
        )}
        <span className="ml-auto shrink-0">
          <TimeAgo iso={session.lastActivity} />
        </span>
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
        <span className="ml-auto shrink-0">
          <TimeAgo iso={message.timestamp} />
        </span>
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
  const { header, messages, following, setFollowing, loading, error } = useSessionTail(project, id);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest message in view while following; a paused reader is left
  // wherever they scrolled to.
  useEffect(() => {
    if (following) endRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [messages, following]);

  const toolUses = messages.filter((m) => m.toolName).length;
  return (
    <Page
      title={header?.title ?? "Transcript"}
      crumbs={[
        { label: "Command Center", href: "#/command" },
        { label: "Sessions", href: "#/sessions" },
      ]}
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFollowing(!following)}
            aria-pressed={following}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition ${
              following
                ? "border-ok/40 bg-ok/10 text-ok"
                : "border-line bg-surface text-ink-dim hover:border-ink-faint/40 hover:text-ink"
            }`}
          >
            {following ? (
              <>
                <span className="relative flex h-2 w-2" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
                </span>
                Following
              </>
            ) : (
              <>▶ Follow live</>
            )}
          </button>
          {header && (
            <a
              href={`/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}/export`}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-dim transition hover:border-ink-faint/40 hover:text-ink"
            >
              ↓ Export Markdown
            </a>
          )}
        </div>
      }
    >
      <a
        href="#/sessions"
        className="mb-6 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-dim transition hover:border-ink-faint/40 hover:text-ink"
      >
        ← Back to sessions
      </a>
      {header && (
        <div className="mb-6">
          <p className="truncate font-mono text-xs text-ink-faint">{header.projectLabel}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
            <span>
              {messages.length} {messages.length === 1 ? "msg" : "msgs"}
            </span>
            <span>
              · {toolUses} {toolUses === 1 ? "tool" : "tools"}
            </span>
            {header.model && <span>· {header.model}</span>}
            <span className="flex items-center gap-1">
              · last activity <TimeAgo iso={header.lastActivity} />
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't load transcript: ${error}`} />
        </div>
      )}

      {loading ? (
        <Loading label="the transcript">
          <SkeletonText lines={6} />
        </Loading>
      ) : messages.length === 0 ? (
        <EmptyState>No displayable messages in this session.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {messages.map((m) => (
            <MessageRow key={m.index} message={m} />
          ))}
          <div ref={endRef} aria-hidden />
        </div>
      )}
    </Page>
  );
}

function SessionGrid({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {sessions.map((s) => (
        <SessionCard key={`${s.project}/${s.id}`} session={s} />
      ))}
    </div>
  );
}

/**
 * The transcript index.
 *
 * Two changes make it usable past the first screen: the same fuzzy search the
 * palette uses, and day headings. Recency order alone answers "what did I just
 * do" and nothing else — "the one from Tuesday about the migration" needed
 * scrolling and guessing.
 */
function SessionList({
  sessions,
  loading,
  error,
}: {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
}) {
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const matches = useMemo(() => filterSessions(sessions, query), [sessions, query]);
  // Grouping is for browsing. Once you are searching, rank order is the answer
  // and day headings would fight it.
  const groups = useMemo(
    () => (searching ? [] : groupSessionsByDay(sessions)),
    [sessions, searching],
  );
  const projects = useMemo(() => new Set(sessions.map((s) => s.project)).size, [sessions]);

  return (
    <Page title="Sessions" crumbs={[{ label: "Command Center", href: "#/command" }]}>
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <p className="text-sm text-ink-faint">
          {loading && sessions.length === 0
            ? "Recent Claude Code transcripts across all projects"
            : searching
              ? `${matches.length} of ${sessions.length} ${
                  sessions.length === 1 ? "transcript" : "transcripts"
                }`
              : `${sessions.length} ${
                  sessions.length === 1 ? "transcript" : "transcripts"
                } across ${projects} ${projects === 1 ? "project" : "projects"}`}
        </p>
        {sessions.length > 0 && (
          <label className="ml-auto flex min-w-[16rem] items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5">
            <span aria-hidden="true" className="text-xs text-ink-faint">
              ⌕
            </span>
            <input
              type="search"
              aria-label="Filter sessions by title, project or model"
              placeholder="Filter transcripts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-transparent text-sm text-ink placeholder-ink-faint outline-none"
            />
          </label>
        )}
      </div>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't reach the Argus server: ${error}`} />
        </div>
      )}

      {loading && sessions.length === 0 ? (
        <Loading label="sessions">
          <SkeletonGrid count={4} columns={2} lines={3} />
        </Loading>
      ) : sessions.length === 0 ? (
        <EmptyState>
          <p className="text-sm text-ink-dim">No transcripts yet.</p>
          <p className="mx-auto mt-2 max-w-md text-xs">
            Argus reads Claude Code&apos;s own session files under{" "}
            <code className="font-mono text-ink-dim">~/.claude/projects</code>. Run{" "}
            <code className="font-mono text-ink-dim">claude</code> in any directory, or fire a
            schedule, and the transcript will show up here — searchable, exportable, and live while
            it runs.
          </p>
        </EmptyState>
      ) : searching ? (
        matches.length === 0 ? (
          <EmptyState>
            <p className="text-sm text-ink-dim">Nothing matches “{query.trim()}”.</p>
            <p className="mt-2 text-xs">
              The filter matches session titles, project paths and model names.
            </p>
          </EmptyState>
        ) : (
          <SessionGrid sessions={matches} />
        )
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map((group) => (
            <section key={group.key}>
              <h2 className="mb-3 flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                {group.label}
                <span className="text-ink-faint/60">{group.sessions.length}</span>
              </h2>
              <SessionGrid sessions={group.sessions} />
            </section>
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
  return <SessionList sessions={sessions} loading={loading} error={error} />;
}
