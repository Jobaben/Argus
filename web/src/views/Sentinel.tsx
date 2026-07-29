import { useState } from "react";
import {
  Card,
  EmptyState,
  formatCountdown,
  Handoff,
  HealthCounter,
  Page,
  Section,
  SkeletonRows,
  TimeAgo,
  useTicker,
} from "../ds";
import { useSentinel } from "../useSentinel";
import type { Incident, IncidentEventKind, IncidentSeverity, IncidentStatus } from "../types";

/**
 * Sentinel.
 *
 * The page is ordered the way an on-call person reads under pressure: what is
 * on fire, how long it has been on fire, and what has already been tried. The
 * timeline is the point — an incident that cannot tell you what happened while
 * you were asleep is just a red dot.
 *
 * The diagnostic's remediation is rendered as a **proposal**, visually distinct
 * from anything clickable, because it is the one thing on this page that looks
 * like an instruction and is not one.
 */

const STATUS_STYLE: Record<IncidentStatus, string> = {
  open: "border-fail/40 bg-fail/12 text-fail",
  acknowledged: "border-await/40 bg-await/12 text-await",
  resolved: "border-ok/40 bg-ok/12 text-ok",
};

const EVENT_GLYPH: Record<IncidentEventKind, string> = {
  opened: "◆",
  escalated: "▲",
  acknowledged: "✓",
  diagnosed: "⌕",
  note: "·",
  resolved: "■",
  reopened: "↻",
  suppressed: "◌",
};

function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] ${
        severity === "critical"
          ? "border-fail/40 bg-fail/12 text-fail"
          : "border-await/40 bg-await/12 text-await"
      }`}
    >
      {severity}
    </span>
  );
}

/** Live countdown to the next escalation. Its own clock, like the board's. */
function EscalatesIn({ at }: { at: string }) {
  const now = useTicker();
  return (
    <span
      className="font-mono text-[11px] text-await"
      title={`Escalates at ${new Date(at).toLocaleString()}`}
    >
      escalates {formatCountdown(new Date(at).getTime() - now)}
    </span>
  );
}

function Timeline({ incident }: { incident: Incident }) {
  return (
    <ol className="mt-3 space-y-1 border-t border-line pt-3">
      {incident.timeline.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex items-baseline gap-2 text-xs">
          <span aria-hidden="true" className="w-3 shrink-0 text-center font-mono text-ink-faint">
            {EVENT_GLYPH[e.kind]}
          </span>
          <span className="shrink-0 text-ink-faint">
            <TimeAgo iso={e.at} />
          </span>
          <span className="min-w-0 flex-1 break-words text-ink-dim">{e.detail}</span>
          {e.by !== "sentinel" && (
            <span className="shrink-0 font-mono text-[10px] text-queue">
              {e.by.replace(/^user:/, "")}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function IncidentCard({
  incident,
  busy,
  onAct,
}: {
  incident: Incident;
  busy: boolean;
  onAct: (action: "ack" | "resolve" | "note" | "diagnose", body?: unknown) => void;
}) {
  const [open, setOpen] = useState(incident.status !== "resolved");
  const [note, setNote] = useState("");
  const live = incident.status !== "resolved";

  return (
    <Card className={live && incident.severity === "critical" ? "border-fail/30" : undefined}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] ${STATUS_STYLE[incident.status]}`}
        >
          {incident.status}
        </span>
        <SeverityBadge severity={incident.severity} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-ink"
          title={incident.title}
        >
          {incident.title}
        </button>
        {incident.level > 0 && live && (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-fail">
            level {incident.level}
          </span>
        )}
        <span className="shrink-0 text-xs text-ink-faint">
          opened <TimeAgo iso={incident.openedAt} />
        </span>
      </div>

      <p className="mt-1 break-words font-mono text-[11.5px] text-ink-dim">{incident.detail}</p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {incident.status === "open" && incident.nextEscalationAt && (
          <EscalatesIn at={incident.nextEscalationAt} />
        )}
        {incident.acknowledgedBy && (
          <span className="font-mono text-[11px] text-await">
            acknowledged by {incident.acknowledgedBy}
          </span>
        )}
        {incident.scheduleId && (
          <a href="#/monitors" className="font-mono text-[11px] text-queue hover:underline">
            monitor
          </a>
        )}
        {incident.runId && (
          <a
            href={`#/run/${encodeURIComponent(incident.runId)}`}
            className="font-mono text-[11px] text-eye hover:underline"
          >
            ▶ replay the run
          </a>
        )}
        {incident.fingerprint && (
          <a href="#/issues" className="font-mono text-[11px] text-queue hover:underline">
            issue
          </a>
        )}
      </div>

      {incident.diagnosis && (
        <div className="mt-3 rounded-md border border-line bg-ground-2 px-3 py-2">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            Diagnostic — read-only
            {incident.diagnosis.confidence != null &&
              ` · ${Math.round(incident.diagnosis.confidence * 100)}% confident`}
          </p>
          {incident.diagnosis.status === "ready" ? (
            <>
              <p className="mb-2 max-w-prose text-sm text-ink">{incident.diagnosis.findings}</p>
              {incident.diagnosis.remediation && (
                <p className="max-w-prose border-l-2 border-await/50 pl-3 text-sm text-ink-dim">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-await">
                    Proposed, not done —{" "}
                  </span>
                  {incident.diagnosis.remediation}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-faint">
              {incident.diagnosis.status === "skipped"
                ? "Diagnostics are switched off on this server (ARGUS_ANALYSIS=off)."
                : `The diagnostic didn't complete: ${incident.diagnosis.error ?? "unknown reason"}`}
            </p>
          )}
        </div>
      )}

      {live && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {incident.status === "open" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAct("ack")}
              className="rounded-md border border-await/40 bg-await/10 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-await transition hover:bg-await/20 disabled:opacity-50"
            >
              Acknowledge
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct("resolve", { note: "resolved from the incident list" })}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-50"
            title="Resolve by hand. If the condition is still live, the next check reopens it and says so."
          >
            Resolve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct("diagnose")}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-50"
            title="Dispatch a read-only diagnostic agent. It proposes; it never acts."
          >
            {busy ? "Working…" : incident.diagnosis ? "Re-diagnose" : "Diagnose"}
          </button>
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!note.trim()) return;
              onAct("note", { note });
              setNote("");
            }}
          >
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note…"
              aria-label={`Add a note to ${incident.title}`}
              className="min-w-32 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink placeholder-ink-faint"
            />
            <button
              type="submit"
              disabled={busy || !note.trim()}
              className="rounded-md border border-line px-2 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-40"
            >
              Note
            </button>
          </form>
        </div>
      )}

      {open && <Timeline incident={incident} />}
    </Card>
  );
}

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

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex items-center gap-2 text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={policy.enabled}
            onChange={(e) => onSave({ enabled: e.target.checked })}
          />
          <span className="font-medium">Sentinel is on</span>
        </label>

        <label className="flex items-center gap-2 text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={policy.autoDiagnose}
            onChange={(e) => onSave({ autoDiagnose: e.target.checked })}
          />
          <span>
            <span className="font-medium">Diagnose new incidents automatically</span>
            <span className="block text-ink-faint">
              Dispatches a read-only agent when an incident opens. It reads the incident and recent
              runs, proposes a remediation, and never executes one.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-dim">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={policy.quietHours != null}
              onChange={(e) =>
                onSave({
                  quietHours: e.target.checked ? { start: quietStart, end: quietEnd } : null,
                })
              }
            />
            <span className="font-medium">Quiet hours</span>
          </label>
          <input
            type="time"
            aria-label="Quiet hours start"
            value={quietStart}
            onChange={(e) => setQuietStart(e.target.value)}
            onBlur={() =>
              policy.quietHours && onSave({ quietHours: { start: quietStart, end: quietEnd } })
            }
            className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
          />
          <span aria-hidden="true">–</span>
          <input
            type="time"
            aria-label="Quiet hours end"
            value={quietEnd}
            onChange={(e) => setQuietEnd(e.target.value)}
            onBlur={() =>
              policy.quietHours && onSave({ quietHours: { start: quietStart, end: quietEnd } })
            }
            className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
          />
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={policy.quietHoursOverrideCritical}
              onChange={(e) => onSave({ quietHoursOverrideCritical: e.target.checked })}
            />
            <span>criticals still ring</span>
          </label>
        </div>
      </div>

      <p className="mt-3 text-xs text-ink-faint">
        Escalation:{" "}
        {policy.levels.map((l, i) => (
          <span key={i}>
            {i > 0 && " → "}
            <span className="text-ink-dim">{l.label}</span>
            {l.afterMinutes > 0 && ` after ${l.afterMinutes}m`}
          </span>
        ))}
        {inQuietHours && (
          <span className="ml-2 rounded-full bg-queue/12 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-queue">
            quiet right now — records still land, the bell stays silent
          </span>
        )}
      </p>
    </Card>
  );
}

export default function Sentinel() {
  const { state, loading, error, busyId, actionError, act, savePolicy } = useSentinel();
  const live = state.incidents.filter((i) => i.status !== "resolved");
  const resolved = state.incidents.filter((i) => i.status === "resolved");

  return (
    <Page title="Sentinel" crumbs={[{ label: "Monitors", href: "#/monitors" }]}>
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <HealthCounter label="Open" value={state.summary.open} tone="fail" />
        <HealthCounter label="Acknowledged" value={state.summary.acknowledged} tone="run" />
        <HealthCounter label="Critical" value={state.summary.critical} tone="fail" />
        <HealthCounter label="Resolved" value={state.summary.resolved} tone="live" />
      </section>

      {error && (
        <div className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail">
          Couldn't load Sentinel: {error}
        </div>
      )}
      {actionError && (
        <div
          role="alert"
          className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail"
        >
          {actionError}
          {/auth/i.test(actionError) && " — sign in to act on incidents."}
        </div>
      )}

      <Section title="Policy">
        <PolicyPanel
          policy={state.policy}
          inQuietHours={state.inQuietHours}
          onSave={(patch) => void savePolicy(patch)}
        />
      </Section>

      <Section title={`Live incidents${live.length > 0 ? ` (${live.length})` : ""}`}>
        <Handoff
          busy={loading && state.incidents.length === 0}
          label="incidents"
          skeleton={<SkeletonRows count={3} />}
        >
          {live.length === 0 ? (
            <EmptyState>
              Nothing is on fire. Sentinel opens an incident when a monitor goes down or starts
              failing, when an issue you'd marked resolved comes back, or when a run leaves its
              learned envelope badly enough to be critical — then escalates it on a clock until
              somebody acknowledges.
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
          <div className="space-y-3">
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
    </Page>
  );
}
