import { useRef, useState } from "react";
import {
  AlertStrip,
  Button,
  ButtonLink,
  EmptyState,
  fieldClass,
  formatCountdown,
  Handoff,
  HealthCounter,
  Icon,
  Page,
  Section,
  SkeletonCounters,
  SkeletonRows,
  TimeAgo,
  useTicker,
  type IconName,
} from "../ds";
import { useSentinel } from "../useSentinel";
import type { Incident, IncidentEventKind, IncidentSeverity, IncidentStatus } from "../types";

/**
 * Sentinel.
 *
 * The page is ordered the way an on-call person reads under pressure: what is
 * on fire, how long it has been on fire, and what has already been tried. The
 * timeline is the point — an incident that cannot tell you what happened while
 * you were asleep is just a red dot. The policy that decides when the bell
 * rings is configuration, read once and rarely changed, so it sits beside the
 * incidents rather than above them.
 *
 * The diagnostic's remediation is rendered as a **proposal**, visually distinct
 * from anything clickable, because it is the one thing on this page that looks
 * like an instruction and is not one.
 */

type Action = "ack" | "resolve" | "note" | "diagnose";

/** StatusPill's anatomy: open is a failure standing, acknowledged is a human
 *  on it (waiting, violet), resolved is done. */
const STATUS_STYLE: Record<IncidentStatus, string> = {
  open: "border-fail/35 bg-fail/12 text-fail",
  acknowledged: "border-await/40 bg-await/12 text-await",
  resolved: "border-ok/25 bg-ok/10 text-ok",
};

/** The rule down a live card's edge: the same mark a counter tile uses. */
const STATUS_RULE: Record<IncidentStatus, string> = {
  open: "bg-fail",
  acknowledged: "bg-await",
  resolved: "bg-transparent",
};

const EVENT_ICON: Record<IncidentEventKind, { icon: IconName; className: string }> = {
  opened: { icon: "alert", className: "text-fail" },
  escalated: { icon: "arrow-up", className: "text-fail" },
  acknowledged: { icon: "check", className: "text-await" },
  diagnosed: { icon: "sparkle", className: "text-ink-dim" },
  note: { icon: "edit", className: "text-ink-dim" },
  resolved: { icon: "check-circle", className: "text-ok" },
  reopened: { icon: "retry", className: "text-fail" },
  suppressed: { icon: "bell-off", className: "text-ink-faint" },
};

const PILL =
  "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-2.5 text-caption font-semibold capitalize leading-none";

function StatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <span className={`${PILL} ${STATUS_STYLE[status]}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {status}
    </span>
  );
}

/** Severity is not a status, so only the one that means "worse" is coloured;
 *  a warning is a neutral pill with a mark, not a second shade of alarm. Once
 *  the incident is resolved even a critical is history, and `muted` says so. */
function SeverityBadge({
  severity,
  muted = false,
}: {
  severity: IncidentSeverity;
  muted?: boolean;
}) {
  return (
    <span
      className={`${PILL} ${
        severity === "critical" && !muted
          ? "border-fail/35 bg-fail/12 text-fail"
          : "border-line-strong bg-ink-faint/8 text-ink-dim"
      }`}
    >
      <Icon name="alert" size={12} />
      {severity}
    </span>
  );
}

/** Live countdown to the next escalation. Its own clock, like the board's. */
function EscalatesIn({ at }: { at: string }) {
  const now = useTicker();
  const left = formatCountdown(new Date(at).getTime() - now);
  return (
    <span
      className="inline-flex items-center gap-1 font-semibold text-await"
      title={`Escalates at ${new Date(at).toLocaleString()}`}
    >
      <Icon name="clock" size={13} />
      {left === "due now" ? "Escalation due now" : `Escalates ${left}`}
    </span>
  );
}

/** A count beside a section heading, in the tone of the worst thing counted. */
function CountBadge({ n, tone }: { n: number; tone: "fail" | "await" }) {
  return (
    <span
      className={`ml-2 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 align-[1px] text-micro font-semibold normal-case tracking-normal ${
        tone === "fail" ? "bg-fail/15 text-fail" : "bg-await/15 text-await"
      }`}
    >
      {n}
    </span>
  );
}

function Timeline({ incident }: { incident: Incident }) {
  return (
    <ol className="mt-2.5">
      {incident.timeline.map((e, i) => {
        const mark = EVENT_ICON[e.kind];
        return (
          <li
            key={`${e.at}-${i}`}
            className="relative flex gap-3 pb-3 last:pb-0 before:absolute before:bottom-0 before:left-[11px] before:top-6 before:w-px before:bg-line last:before:hidden"
          >
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 ${mark.className}`}
            >
              <Icon name={mark.icon} size={13} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="break-words text-small text-ink-dim">{e.detail}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-caption">
                <TimeAgo iso={e.at} />
                {e.by !== "sentinel" && (
                  <span className="inline-flex items-center gap-1 font-semibold text-ink-dim">
                    <Icon name="user" size={12} className="text-ink-faint" />
                    {e.by.replace(/^user:/, "")}
                  </span>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const BUSY_LABEL: Record<Action, string> = {
  ack: "Acknowledging…",
  resolve: "Resolving…",
  diagnose: "Diagnosing…",
  note: "Adding…",
};

function IncidentCard({
  incident,
  busy,
  onAct,
}: {
  incident: Incident;
  busy: boolean;
  onAct: (action: Action, body?: unknown) => void;
}) {
  const [open, setOpen] = useState(incident.status !== "resolved");
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  // Which button started the request in flight, so the label that changes is
  // the one that was pressed — "Working…" on Diagnose while an acknowledgement
  // was the thing in flight was a small lie about what the page was doing.
  const [pressed, setPressed] = useState<Action | null>(null);
  const busyAction = busy ? pressed : null;
  const live = incident.status !== "resolved";
  // A resolved incident is history: collapsed, it is one line. A live one is
  // always shown whole; only its timeline folds away.
  const showBody = live || open;
  const hasLinks = Boolean(incident.scheduleId || incident.runId || incident.fingerprint);
  const hasMeta =
    hasLinks ||
    incident.acknowledgedBy != null ||
    (live && incident.level > 0) ||
    (incident.status === "open" && incident.nextEscalationAt != null);
  // The actions are marked unavailable while a request is in flight rather
  // than `disabled`, which would drop keyboard focus from the button just
  // pressed to the page; this guard is what actually holds them.
  const act = (action: Action, body?: unknown) => {
    if (busy) return;
    setPressed(action);
    onAct(action, body);
  };
  const label = (action: Action, idle: string) =>
    busyAction === action ? BUSY_LABEL[action] : idle;

  const chevron = (
    <Icon
      name="chevron-right"
      size={live ? 14 : 16}
      className={`shrink-0 text-ink-faint transition-transform duration-(--duration-quick) ease-(--ease-out-expo) group-hover:text-ink ${
        open ? "rotate-90" : ""
      }`}
    />
  );

  return (
    // A live incident is a card with its status down its edge; a resolved one
    // is a row in the history panel, one line until it is opened.
    <article
      className={
        live
          ? `relative overflow-hidden rounded-tile border bg-surface px-4 py-4 shadow-raised sm:px-5 ${
              incident.severity === "critical" ? "border-fail/35" : "border-line"
            }`
          : "px-4 py-3 sm:px-5"
      }
    >
      {live ? (
        <>
          <span
            aria-hidden="true"
            className={`absolute inset-y-0 left-0 w-[3px] ${STATUS_RULE[incident.status]}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={incident.status} />
            <SeverityBadge severity={incident.severity} />
            <span className="ml-auto text-caption text-ink-faint">
              Opened <TimeAgo iso={incident.openedAt} />
            </span>
          </div>
          <h3 className="mt-2.5 break-words text-title font-semibold text-ink">{incident.title}</h3>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* Here the title is the disclosure: it opens the whole row. */}
          <h3 className="flex min-w-0 basis-full sm:flex-1 sm:basis-auto">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="group flex min-w-0 items-start gap-2 rounded-sm text-left"
              title={incident.title}
            >
              <span className="mt-0.5">{chevron}</span>
              <span className="min-w-0 break-words text-sm font-semibold text-ink-dim group-hover:text-ink">
                {incident.title}
              </span>
            </button>
          </h3>
          {/* On a phone the title gets the row and this goes under it. */}
          <span className="flex items-center gap-3 max-sm:pl-6">
            <SeverityBadge severity={incident.severity} muted />
            <span className="text-caption text-ink-faint">
              Resolved <TimeAgo iso={incident.resolvedAt ?? incident.updatedAt} />
            </span>
          </span>
        </div>
      )}

      <div className={live ? undefined : "pl-6"}>
        {showBody && (
          <>
            <p className="mt-1 break-words text-small text-ink-dim">{incident.detail}</p>
            {hasMeta && (
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-caption">
                {incident.status === "open" && incident.nextEscalationAt && (
                  <EscalatesIn at={incident.nextEscalationAt} />
                )}
                {incident.level > 0 && live && (
                  <span className="inline-flex items-center gap-1 font-semibold capitalize text-fail">
                    <Icon name="arrow-up" size={13} />
                    level {incident.level}
                  </span>
                )}
                {incident.acknowledgedBy && (
                  <span className="inline-flex items-center gap-1 text-ink-dim">
                    <Icon name="user" size={13} className="text-await" />
                    acknowledged by {incident.acknowledgedBy}
                  </span>
                )}
                {hasLinks && (
                  <span className="-my-1 flex flex-wrap items-center gap-1 max-sm:-ml-2.5 sm:ml-auto">
                    {incident.scheduleId && (
                      <ButtonLink href="#/health" variant="ghost" size="sm" icon="activity">
                        Monitor
                      </ButtonLink>
                    )}
                    {incident.runId && (
                      <ButtonLink
                        href={`#/run/${encodeURIComponent(incident.runId)}`}
                        variant="ghost"
                        size="sm"
                        icon="replay"
                      >
                        Replay the run
                      </ButtonLink>
                    )}
                    {incident.fingerprint && (
                      <ButtonLink
                        href="#/issues"
                        variant="ghost"
                        size="sm"
                        icon="layers"
                        className="capitalize"
                      >
                        issue
                      </ButtonLink>
                    )}
                  </span>
                )}
              </div>
            )}

            {incident.diagnosis && (
              <div className="mt-4 rounded-control border border-line bg-ground-2/60 px-3.5 py-3">
                <p className="eyebrow mb-1.5 flex items-center gap-1.5">
                  <Icon name="sparkle" size={13} />
                  Diagnostic — read-only
                  {incident.diagnosis.confidence != null &&
                    ` · ${Math.round(incident.diagnosis.confidence * 100)}% confident`}
                </p>
                {incident.diagnosis.status === "ready" ? (
                  <>
                    <p className="max-w-prose text-small text-ink">{incident.diagnosis.findings}</p>
                    {incident.diagnosis.remediation && (
                      <p className="mt-2.5 max-w-prose border-l-2 border-await/50 pl-3 text-small text-ink-dim">
                        <span className="eyebrow text-await">Proposed, not done — </span>
                        {incident.diagnosis.remediation}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-small text-ink-faint">
                    {incident.diagnosis.status === "skipped"
                      ? "Diagnostics are switched off on this server (ARGUS_ANALYSIS=off)."
                      : `The diagnostic didn't complete: ${incident.diagnosis.error ?? "unknown reason"}`}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {live && (
          // Keyed by position, not by action: acknowledging removes the first
          // button, and keyed by action the button holding focus would go with
          // it. This way it becomes Resolve, and focus stays put.
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {[
              ...(incident.status === "open"
                ? [
                    {
                      action: "ack" as const,
                      variant: "attention" as const,
                      icon: "check" as const,
                      text: "Acknowledge",
                      title:
                        "Take it: stops the escalation clock and tells everyone someone is on it.",
                    },
                  ]
                : []),
              {
                action: "resolve" as const,
                variant: "secondary" as const,
                icon: "check-circle" as const,
                text: "Resolve",
                title:
                  "Resolve by hand. If the condition is still live, the next check reopens it and says so.",
              },
              {
                action: "diagnose" as const,
                variant: "ghost" as const,
                icon: "sparkle" as const,
                text: incident.diagnosis ? "Re-diagnose" : "Diagnose",
                title: "Dispatch a read-only diagnostic agent. It proposes; it never acts.",
              },
            ].map((b, slot) => (
              <Button
                key={slot}
                variant={b.variant}
                icon={b.icon}
                aria-disabled={busy || undefined}
                onClick={() =>
                  act(
                    b.action,
                    b.action === "resolve"
                      ? { note: "resolved from the incident list" }
                      : undefined,
                  )
                }
                title={b.title}
              >
                {label(b.action, b.text)}
              </Button>
            ))}
          </div>
        )}

        {/* On a live card the timeline is the one part that folds, so its
            own heading is the control — next to what it hides. */}
        {live ? (
          <div className="mt-4 border-t border-line pt-3">
            <h4>
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="group -mx-1 flex items-center gap-1.5 rounded-sm px-1"
              >
                {chevron}
                <span className="eyebrow transition-colors duration-(--duration-quick) group-hover:text-ink-dim">
                  Timeline
                </span>
                {!open && (
                  <span className="text-caption text-ink-faint">
                    · {incident.timeline.length} event{incident.timeline.length === 1 ? "" : "s"}
                  </span>
                )}
              </button>
            </h4>
            {open && <Timeline incident={incident} />}
          </div>
        ) : (
          open && (
            <div className="mt-4 border-t border-line pt-3">
              <h4 className="eyebrow">Timeline</h4>
              <Timeline incident={incident} />
            </div>
          )
        )}

        {live && (
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || !note.trim()) return;
              act("note", { note });
              setNote("");
              // Sent from the button, which goes inert once the field is
              // empty: the caret goes back to the field, ready for the next.
              noteRef.current?.focus();
            }}
          >
            <input
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note to the timeline…"
              aria-label={`Add a note to ${incident.title}`}
              className={`${fieldClass} h-8 flex-1`}
            />
            <Button
              type="submit"
              icon="edit"
              disabled={!note.trim()}
              aria-disabled={busy || undefined}
            >
              {label("note", "Note")}
            </Button>
          </form>
        )}
      </div>
    </article>
  );
}

const checkboxClass = "mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-eye";

function PolicyPanel({
  policy,
  inQuietHours,
  onSave,
}: {
  policy: ReturnType<typeof useSentinel>["state"]["policy"];
  inQuietHours: boolean;
  onSave: (patch: Parameters<ReturnType<typeof useSentinel>["savePolicy"]>[0]) => void;
}) {
  const [quietStart, setQuietStart] = useState(policy.quietHours?.start ?? "22:00");
  const [quietEnd, setQuietEnd] = useState(policy.quietHours?.end ?? "07:00");
  // The fields are drafts of the server's window, so when the server's window
  // changes (a save landing, another tab) the drafts follow it. Turning quiet
  // hours off keeps the last window in the fields, ready to turn back on.
  const [synced, setSynced] = useState(policy.quietHours);
  const q = policy.quietHours;
  if (q && (q.start !== synced?.start || q.end !== synced?.end)) {
    setSynced(q);
    setQuietStart(q.start);
    setQuietEnd(q.end);
  }

  return (
    <div className="divide-y divide-line rounded-tile border border-line bg-surface shadow-raised">
      <label className="flex cursor-pointer items-start gap-3 px-4 py-3.5">
        <input
          type="checkbox"
          className={checkboxClass}
          checked={policy.enabled}
          onChange={(e) => onSave({ enabled: e.target.checked })}
        />
        <span className="min-w-0">
          <span className="block text-small font-semibold text-ink">Sentinel is on</span>
          <span className="mt-0.5 block text-caption text-ink-faint">
            When it is off, no incident opens and none escalates.
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-3 px-4 py-3.5">
        <input
          type="checkbox"
          className={checkboxClass}
          checked={policy.autoDiagnose}
          onChange={(e) => onSave({ autoDiagnose: e.target.checked })}
        />
        <span className="min-w-0">
          <span className="block text-small font-semibold text-ink">
            Diagnose new incidents automatically
          </span>
          <span className="mt-0.5 block text-caption text-ink-faint">
            Dispatches a read-only agent when an incident opens. It reads the incident and recent
            runs, proposes a remediation, and never executes one.
          </span>
        </span>
      </label>

      <div className="px-4 py-3.5">
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className={`${checkboxClass} mt-0`}
            checked={policy.quietHours != null}
            onChange={(e) =>
              onSave({
                quietHours: e.target.checked ? { start: quietStart, end: quietEnd } : null,
              })
            }
          />
          <span className="text-small font-semibold text-ink">Quiet hours</span>
        </label>
        <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-7">
          <input
            type="time"
            aria-label="Quiet hours start"
            value={quietStart}
            onChange={(e) => setQuietStart(e.target.value)}
            onBlur={() =>
              policy.quietHours && onSave({ quietHours: { start: quietStart, end: quietEnd } })
            }
            className={`${fieldClass} h-8 w-32`}
          />
          <span aria-hidden="true" className="text-ink-faint">
            –
          </span>
          <input
            type="time"
            aria-label="Quiet hours end"
            value={quietEnd}
            onChange={(e) => setQuietEnd(e.target.value)}
            onBlur={() =>
              policy.quietHours && onSave({ quietHours: { start: quietStart, end: quietEnd } })
            }
            className={`${fieldClass} h-8 w-32`}
          />
        </div>
        <label className="mt-2.5 flex cursor-pointer items-center gap-2.5 pl-7 text-small text-ink-dim">
          <input
            type="checkbox"
            className={`${checkboxClass} mt-0`}
            checked={policy.quietHoursOverrideCritical}
            onChange={(e) => onSave({ quietHoursOverrideCritical: e.target.checked })}
          />
          <span>Criticals still ring</span>
        </label>
        {inQuietHours && (
          <p className="mt-3 flex items-start gap-2 rounded-control bg-ground-2/60 px-3 py-2 text-caption text-ink-dim">
            <Icon name="bell-off" size={14} className="mt-px text-ink-faint" />
            <span>Quiet right now — records still land, the bell stays silent.</span>
          </p>
        )}
      </div>

      <div className="px-4 py-3.5">
        <h3 className="eyebrow">Escalation</h3>
        {policy.levels.length === 0 ? (
          <p className="mt-2 text-caption text-ink-faint">No escalation levels are configured.</p>
        ) : (
          // Steps, not a list element: the incident timeline is this page's one
          // list, and a reader paging through lists should land on it.
          <div className="mt-2.5 flex flex-col gap-2">
            {policy.levels.map((l, i) => (
              <div key={i} className="flex items-baseline gap-2.5 text-small">
                <span
                  aria-hidden="true"
                  className="flex h-5 w-5 shrink-0 translate-y-[-1px] items-center justify-center self-center rounded-full border border-line-strong text-micro font-semibold text-ink-dim"
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 text-ink">{l.label}</span>
                <span className="shrink-0 text-caption text-ink-faint">
                  {l.afterMinutes > 0 ? `after ${l.afterMinutes}m` : "right away"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Sentinel() {
  const { state, loading, error, busyId, actionError, act, savePolicy, refresh } = useSentinel();
  const [saving, setSaving] = useState(0);
  const live = state.incidents.filter((i) => i.status !== "resolved");
  const resolved = state.incidents.filter((i) => i.status === "resolved");
  const firstLoad = loading && state.incidents.length === 0;
  // Nothing has loaded and the load failed: the strip says so, once. Zeroed
  // counters and "Nothing is on fire" beneath it would be reassurance the page
  // has no grounds for.
  const nothingLoaded = error != null && state.incidents.length === 0;
  // Every answer from the server is stamped; the placeholder the hook starts
  // from is not. Without a stamp the policy on hand is that placeholder, and
  // showing it — "Sentinel is on", no escalation levels — would state settings
  // nobody has read, one click away from saving them over the real ones.
  const policyKnown = state.generatedAt !== "";

  const save = (patch: Parameters<typeof savePolicy>[0]) => {
    setSaving((n) => n + 1);
    void savePolicy(patch).finally(() => setSaving((n) => n - 1));
  };

  return (
    <Page
      title="Sentinel"
      subtitle="Incidents from down monitors, returning issues and runs far outside their envelope — escalated until someone answers."
    >
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Sentinel"
            message={`Couldn't load Sentinel: ${error}`}
            action={
              <Button size="sm" icon="retry" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}
      {actionError && (
        <div role="alert" className="mb-6">
          <AlertStrip
            subject="Not done"
            message={`${actionError}${/auth/i.test(actionError) ? " — sign in to act on incidents." : ""}`}
          />
        </div>
      )}

      {!nothingLoaded && (
        <div className="mb-8">
          <Handoff
            busy={firstLoad}
            label="incident counts"
            skeleton={<SkeletonCounters count={4} />}
          >
            <section
              aria-label="Incidents by state"
              className="grid grid-cols-2 gap-3 sm:grid-cols-4"
            >
              <HealthCounter label="Open" value={state.summary.open} tone="fail" />
              <HealthCounter label="Acknowledged" value={state.summary.acknowledged} tone="await" />
              <HealthCounter label="Critical" value={state.summary.critical} tone="fail" />
              <HealthCounter label="Resolved" value={state.summary.resolved} tone="ok" />
            </section>
          </Handoff>
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:items-start">
        <div className="min-w-0">
          <Section
            title={
              <>
                Live incidents
                {live.length > 0 && (
                  <CountBadge
                    n={live.length}
                    tone={live.some((i) => i.status === "open") ? "fail" : "await"}
                  />
                )}
              </>
            }
          >
            <Handoff busy={firstLoad} label="incidents" skeleton={<SkeletonRows count={3} />}>
              {nothingLoaded ? (
                <EmptyState compact icon="alert" title="Incidents can't be shown right now.">
                  Sentinel didn't answer, so this is not an all-clear — just no word yet.
                </EmptyState>
              ) : live.length === 0 ? (
                <EmptyState
                  tone="calm"
                  icon="check-circle"
                  title="Nothing is on fire."
                  action={
                    <ButtonLink href="#/health" iconRight="arrow-right">
                      Health
                    </ButtonLink>
                  }
                >
                  Sentinel opens an incident when a monitor goes down or starts failing, when an
                  issue you'd marked resolved comes back, or when a run leaves its learned envelope
                  badly enough to be critical — then escalates it on a clock until somebody
                  acknowledges.
                </EmptyState>
              ) : (
                <div className="space-y-3">
                  {live.map((i) => (
                    <IncidentCard
                      key={i.id}
                      incident={i}
                      busy={busyId === i.id}
                      onAct={(action, body) => void act(i.id, action, body)}
                    />
                  ))}
                </div>
              )}
            </Handoff>
          </Section>

          {resolved.length > 0 && (
            <Section title={`Resolved (${resolved.length})`}>
              <div className="divide-y divide-line rounded-tile border border-line bg-surface/60 shadow-raised">
                {resolved.map((i) => (
                  <IncidentCard
                    key={i.id}
                    incident={i}
                    busy={busyId === i.id}
                    onAct={(action, body) => void act(i.id, action, body)}
                  />
                ))}
              </div>
            </Section>
          )}
        </div>

        <aside className="min-w-0">
          <Section
            title="Policy"
            action={
              saving > 0 ? (
                <span role="status" className="text-caption text-ink-faint">
                  Saving…
                </span>
              ) : undefined
            }
          >
            <Handoff busy={firstLoad} label="policy" skeleton={<SkeletonRows count={4} />}>
              {policyKnown ? (
                <PolicyPanel
                  policy={state.policy}
                  inQuietHours={state.inQuietHours}
                  onSave={save}
                />
              ) : (
                <EmptyState compact icon="alert" title="The policy can't be shown right now.">
                  Sentinel didn't answer, so these settings are unknown — not off.
                </EmptyState>
              )}
            </Handoff>
          </Section>
        </aside>
      </div>
    </Page>
  );
}
