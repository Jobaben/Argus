import { useEffect, useMemo, useRef, useState } from "react";
import { useSessions, type SessionMessage, type SessionSummary } from "../useSessions";
import { useSessionTail } from "../useSessionTail";
import { useHashRoute } from "../useHashRoute";
import {
  AlertStrip,
  Button,
  ButtonLink,
  chipClass,
  EmptyState,
  fieldClass,
  Handoff,
  Icon,
  IconButton,
  Page,
  Skeleton,
  TimeAgo,
  type IconName,
} from "../ds";
import { filterSessions, groupSessionsByDay } from "./sessionList";
import { loadError } from "../live/loadError";

function sessionHref(project: string, id: string): string {
  return `#/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
}

/** The browser's own clear glyph is a bold white ✕ outside the icon set; the
 *  field draws its own clear button instead. */
const SEARCH_FIELD = "[&::-webkit-search-cancel-button]:appearance-none";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One transcript in the index: a row of a single list panel rather than a card
 * of its own. The title is what you scan for, so it is the only strong ink on
 * the row; the project path and the counts are its caption, and the model is a
 * neutral chip — it is a category, and the blue it used to wear means "queued".
 */
function SessionRow({
  session,
  showProject = true,
}: {
  session: SessionSummary;
  /** Off when the list is already narrowed to one project: the filter chip
   *  names it once, and every row repeating the same path is noise. */
  showProject?: boolean;
}) {
  return (
    <a
      href={sessionHref(session.project, session.id)}
      className="group flex items-start gap-3 px-4 py-3 transition-colors duration-(--duration-quick) hover:bg-surface-2/60"
    >
      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-2 text-sm font-semibold text-ink sm:line-clamp-1">
          {session.title}
        </h3>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-faint">
          {showProject && (
            <span className="min-w-0 max-w-full truncate font-mono">{session.projectLabel}</span>
          )}
          <span>
            {plural(session.messageCount, "msg", "msgs")} ·{" "}
            {plural(session.toolUseCount, "tool", "tools")}
          </span>
          {session.model && <span className={chipClass()}>{session.model}</span>}
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-2 pt-0.5 text-caption">
        <TimeAgo iso={session.lastActivity} />
        <Icon
          name="chevron-right"
          size={15}
          className="text-ink-faint transition-transform duration-(--duration-quick) group-hover:translate-x-0.5"
        />
      </span>
    </a>
  );
}

function SessionPanel({
  sessions,
  showProject,
}: {
  sessions: SessionSummary[];
  showProject?: boolean;
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
      {sessions.map((s) => (
        <li key={`${s.project}/${s.id}`}>
          <SessionRow session={s} showProject={showProject} />
        </li>
      ))}
    </ul>
  );
}

/** The list panel's shape, before it has rows. */
function SkeletonSessionPanel({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      <Skeleton className="h-2.5 w-16" />
      <div className="divide-y divide-line rounded-tile border border-line bg-surface">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3.5">
            <div className="flex-1 space-y-2">
              <Skeleton className={`h-3.5 ${i % 2 ? "w-2/5" : "w-3/5"}`} />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
            <Skeleton className="h-2.5 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}

const ROLE: Record<string, { label: string; icon: IconName }> = {
  user: { label: "User", icon: "user" },
  assistant: { label: "Assistant", icon: "sparkle" },
};

/** Past this, a message starts collapsed: one pasted log should not turn the
 *  transcript into a scroll past it to reach the next turn. */
const LONG_LINES = 18;
const LONG_CHARS = 1800;

/**
 * One turn of the transcript.
 *
 * Every message used to be a bordered card with its body in a `<pre>`, so a
 * conversation read as a stack of identical boxes and prose was set like a log.
 * Now the turns are rows of one panel; prose is set as prose, and only a tool
 * call — machine text — is set in monospace, in an inset well. Who is speaking
 * is an icon and a word rather than a coloured pill: the blue and green they
 * wore mean "queued" and "done" everywhere else.
 */
function MessageRow({ message }: { message: SessionMessage }) {
  const [expanded, setExpanded] = useState(false);
  const role = message.role ?? message.type;
  const meta = ROLE[role] ?? {
    label: role ? role.charAt(0).toUpperCase() + role.slice(1) : "Message",
    icon: "info",
  };
  const machine = message.toolName != null;
  const text = message.text;
  const lines = text ? text.split("\n").length : 0;
  const long = text != null && (lines > LONG_LINES || text.length > LONG_CHARS);
  const clamped = long && !expanded;
  const human = role === "user" && !machine;

  return (
    <article
      className={`flex gap-3 px-4 py-4 sm:gap-4 sm:px-5 ${human ? "bg-surface-2/45" : ""} ${
        message.isError ? "shadow-[inset_2px_0_0_var(--color-fail)]" : ""
      }`}
    >
      {/* The speaker's mark is a gutter on a wide screen and moves into the
          header line on a phone, where 40px of gutter is a fifth of the line. */}
      <span
        aria-hidden="true"
        className={`mt-0.5 hidden h-7 w-7 shrink-0 items-center justify-center rounded-full border sm:flex ${
          message.isError
            ? "border-fail/35 bg-fail/10 text-fail"
            : "border-line-strong bg-surface-2 text-ink-dim"
        }`}
      >
        <Icon name={machine ? "terminal" : meta.icon} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon
            name={machine ? "terminal" : meta.icon}
            size={14}
            className={`sm:hidden ${message.isError ? "text-fail" : "text-ink-faint"}`}
          />
          <span className="text-small font-semibold text-ink">{meta.label}</span>
          {message.toolName && (
            <span className={chipClass()}>
              <span className="font-mono">{message.toolName}</span>
            </span>
          )}
          {message.isError && <span className={chipClass("fail")}>error</span>}
          <span className="ml-auto shrink-0 text-caption">
            <TimeAgo iso={message.timestamp} />
          </span>
        </header>
        {text && (
          <div
            className={`mt-1.5 ${
              clamped
                ? "max-h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
                : ""
            }`}
          >
            {machine ? (
              <pre className="whitespace-pre-wrap break-words rounded-control border border-line bg-ground-2/60 p-3 font-mono text-caption leading-relaxed text-ink-dim">
                {text}
              </pre>
            ) : (
              <p className="whitespace-pre-wrap break-words text-body leading-relaxed text-ink-dim">
                {text}
              </p>
            )}
          </div>
        )}
        {long && (
          <Button
            variant="ghost"
            size="sm"
            iconRight={expanded ? "chevron-up" : "chevron-down"}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="-ml-2.5 mt-1"
          >
            {expanded ? "Collapse" : `Show all ${lines} lines`}
          </Button>
        )}
      </div>
    </article>
  );
}

function SkeletonTranscript() {
  return (
    <div className="divide-y divide-line rounded-tile border border-line bg-surface">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex gap-4 px-5 py-4">
          <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className={`h-2.5 ${i % 2 ? "w-1/2" : "w-4/5"}`} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionTranscript({ project, id }: { project: string; id: string }) {
  const { header, messages, following, setFollowing, loading, error, errorStatus } = useSessionTail(
    project,
    id,
  );
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest message in view while following; a paused reader is left
  // wherever they scrolled to.
  useEffect(() => {
    if (following) endRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [messages, following]);

  const toolUses = messages.filter((m) => m.toolName).length;
  // The server's answer for a transcript that is not on disk — pruned, or a
  // link from a run whose session was never written. Not a failed load.
  const notFound = errorStatus === 404 && !header;
  return (
    <Page
      title={header?.title ?? "Transcript"}
      // The crumb is the way back; the "← Back to sessions" button that used to
      // sit under the title said the same thing a second time.
      crumbs={[{ label: "Sessions", href: "#/sessions" }]}
      subtitle={
        header && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-faint">
            <a
              href={`#/sessions/${encodeURIComponent(project)}`}
              title="Every transcript in this project"
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm text-ink-dim transition-colors duration-(--duration-quick) hover:text-ink"
            >
              <Icon name="folder" size={14} />
              <span className="break-all font-mono">{header.projectLabel}</span>
            </a>
            <span>
              {plural(messages.length, "msg", "msgs")} · {plural(toolUses, "tool", "tools")}
            </span>
            {header.model && <span className={chipClass()}>{header.model}</span>}
            <span className="inline-flex items-center gap-1">
              Last activity <TimeAgo iso={header.lastActivity} />
            </span>
          </span>
        )
      }
      // Nothing to follow, or export, until there is a transcript: a live dot
      // over a load that failed would claim a tail of nothing.
      actions={
        header && (
          <>
            <Button onClick={() => setFollowing(!following)} aria-pressed={following}>
              {following ? (
                <>
                  {/* Live is the eye's cyan: green would read as "done". */}
                  <span className="relative flex h-2 w-2" aria-hidden="true">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-eye opacity-60 motion-safe:animate-ping" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-eye" />
                  </span>
                  Following
                </>
              ) : (
                <>
                  <Icon name="play" size={15} />
                  Follow live
                </>
              )}
            </Button>
            <ButtonLink
              href={`/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}/export`}
              icon="arrow-down"
            >
              Export Markdown
            </ButtonLink>
          </>
        )
      }
    >
      {notFound ? (
        <EmptyState
          icon="message"
          title="Transcript not found"
          action={
            <ButtonLink href="#/sessions" iconRight="arrow-right">
              Open Sessions
            </ButtonLink>
          }
        >
          Argus can&apos;t find this session&apos;s file under{" "}
          <code className="font-mono text-ink">~/.claude/projects</code>. Claude Code may have
          pruned it, or it was written under a different Claude home than the one Argus reads.
        </EmptyState>
      ) : (
        <>
          {error && (
            <div className="mb-6">
              <AlertStrip subject="Transcript" message={loadError("the transcript", error)} />
            </div>
          )}
          {/* A reading measure. At the page's full width a paragraph of prose
              is a single line two hand-spans long. */}
          <div className="max-w-5xl">
            <Handoff busy={loading} label="the transcript" skeleton={<SkeletonTranscript />}>
              {messages.length === 0 ? (
                error ? null : (
                  <EmptyState icon="message" title="Nothing to show">
                    No displayable messages in this session.
                  </EmptyState>
                )
              ) : (
                <div className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
                  {messages.map((m) => (
                    <MessageRow key={m.index} message={m} />
                  ))}
                  <div ref={endRef} aria-hidden />
                </div>
              )}
            </Handoff>
          </div>
        </>
      )}
    </Page>
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
  sessions: all,
  loading,
  error,
  project,
  onRetry,
}: {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  /** Encoded project id from `#/sessions/:project` — narrows the list to one
   *  working directory. This is what the Projects page used to be: the same
   *  roll-up, one click closer to the transcripts it counted. */
  project?: string;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState("");
  const filterField = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;
  const sessions = useMemo(
    () => (project ? all.filter((s) => s.project === project) : all),
    [all, project],
  );
  const projectLabel = project ? (sessions[0]?.projectLabel ?? project) : null;
  const matches = useMemo(() => filterSessions(sessions, query), [sessions, query]);
  // Grouping is for browsing. Once you are searching, rank order is the answer
  // and day headings would fight it.
  const groups = useMemo(
    () => (searching ? [] : groupSessionsByDay(sessions)),
    [sessions, searching],
  );
  const projects = useMemo(() => new Set(sessions.map((s) => s.project)).size, [sessions]);
  const noun = sessions.length === 1 ? "transcript" : "transcripts";

  return (
    <Page
      title="Sessions"
      subtitle={
        <>
          {/* No count until there is one to give: "0 transcripts" while loading
              or under a failed load would be a claim about the disk, and above
              an empty state it says the same thing twice. */}
          {sessions.length === 0
            ? project
              ? "Agent transcripts written from one working directory"
              : "Recent agent transcripts across all projects"
            : searching
              ? `${matches.length} of ${sessions.length} ${noun}`
              : project
                ? `${sessions.length} ${noun} in this project`
                : `${sessions.length} ${noun} across ${projects} ${
                    projects === 1 ? "project" : "projects"
                  }`}
          {projectLabel && (
            <span className="ml-2.5 inline-flex max-w-full items-center gap-1 rounded-md border border-line-strong bg-surface-2 py-0.5 pl-2 pr-0.5 align-middle text-caption text-ink-dim">
              <Icon name="folder" size={13} className="text-ink-faint" />
              <span className="truncate font-mono" title={projectLabel}>
                {projectLabel}
              </span>
              <a
                href="#/sessions"
                aria-label="Show every project"
                title="Show every project"
                className="flex h-5 w-5 items-center justify-center rounded text-ink-faint transition-colors duration-(--duration-quick) hover:bg-surface-3 hover:text-ink"
              >
                <Icon name="close" size={13} />
              </a>
            </span>
          )}
        </>
      }
      actions={
        sessions.length > 0 && (
          // The content width on a phone (Page's gutter is 1rem a side), so the
          // field spans the line instead of ending at an arbitrary 288px.
          <div className="relative w-[calc(100vw-2rem)] sm:w-72">
            <Icon
              name="search"
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
            />
            <input
              ref={filterField}
              type="search"
              aria-label="Filter sessions by title, project or model"
              placeholder="Filter transcripts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={`${fieldClass} ${SEARCH_FIELD} h-9 w-full pl-8 ${query ? "pr-9" : ""}`}
            />
            {query && (
              <span className="absolute inset-y-0 right-1 flex items-center">
                <IconButton
                  icon="close"
                  label="Clear the filter"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    filterField.current?.focus();
                  }}
                />
              </span>
            )}
          </div>
        )
      }
    >
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Sessions"
            message={loadError("sessions", error)}
            action={
              <Button size="sm" icon="retry" onClick={onRetry}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      <Handoff
        busy={loading && sessions.length === 0}
        label="sessions"
        skeleton={<SkeletonSessionPanel />}
      >
        {sessions.length === 0 && error ? null : sessions.length === 0 &&
          project &&
          all.length > 0 ? (
          <EmptyState
            icon="folder"
            title="No transcripts in this project"
            action={
              <ButtonLink href="#/sessions" iconRight="arrow-right">
                Show every project
              </ButtonLink>
            }
          >
            Nothing Argus has read was written from this working directory.
          </EmptyState>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon="terminal"
            title="No transcripts yet"
            action={
              <ButtonLink href="#/schedules" icon="calendar">
                Open the Scheduler
              </ButtonLink>
            }
          >
            Argus reads Claude Code&apos;s own session files under{" "}
            <code className="font-mono text-ink">~/.claude/projects</code>. Run{" "}
            <code className="font-mono text-ink">claude</code> in any directory, or fire a schedule,
            and the transcript will show up here — searchable, exportable, and live while it runs.
          </EmptyState>
        ) : searching ? (
          matches.length === 0 ? (
            <EmptyState
              compact
              icon="search"
              title={`Nothing matches “${query.trim()}”`}
              action={
                <Button size="sm" icon="close" onClick={() => setQuery("")}>
                  Clear the filter
                </Button>
              }
            >
              The filter matches session titles, project paths and model names.
            </EmptyState>
          ) : (
            <SessionPanel sessions={matches} showProject={!project} />
          )
        ) : (
          <div className="flex flex-col gap-8">
            {groups.map((group) => (
              <section key={group.key}>
                <h2 className="eyebrow mb-3 flex items-baseline gap-2">
                  {group.label}
                  <span className="tabular-nums text-ink-faint/70">{group.sessions.length}</span>
                </h2>
                <SessionPanel sessions={group.sessions} showProject={!project} />
              </section>
            ))}
          </div>
        )}
      </Handoff>
    </Page>
  );
}

export default function Sessions() {
  const { sessions, loading, error, refresh } = useSessions();
  const segments = useHashRoute();

  // Deep-linkable transcript: #/sessions/:project/:id renders the transcript
  // directly, so a reload or a shared link lands on the same view. One segment
  // short of that, #/sessions/:project, is the list narrowed to a project —
  // the palette's project entries and the Chronicle's session lanes land here.
  if (segments[0] === "sessions" && segments[1] && segments[2]) {
    return <SessionTranscript project={segments[1]} id={segments[2]} />;
  }
  return (
    <SessionList
      sessions={sessions}
      loading={loading}
      error={error}
      onRetry={() => void refresh()}
      {...(segments[0] === "sessions" && segments[1] ? { project: segments[1] } : {})}
    />
  );
}
