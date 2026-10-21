import { useState, type ReactNode } from "react";
import {
  AlertStrip,
  Button,
  Card,
  Icon,
  IconButton,
  Page,
  Section,
  SkeletonGrid,
  TimeAgo,
  chipClass,
  fieldClass,
  formatUsd,
  labelClass,
} from "../ds";
import { useFleet } from "../useFleet";
import type { FleetMachine, MachineSummary, PeerStatus } from "../types";
import { InfoTip } from "../ds/InfoTip";
import { HealthCounter } from "../ds/HealthCounter";
import { loadError } from "../live/loadError";

/**
 * Constellation's page: N machines, one lens.
 *
 * The design problem here is not the list, it is the totals. A number summed
 * over three of five machines is not a fleet number, so the header says how
 * many machines are reporting next to every figure it adds up — and a machine
 * that has gone quiet keeps its last card, marked, rather than disappearing and
 * quietly shrinking the denominator.
 */

type Tone = "ok" | "idle" | "fail";

const STATUS_COPY: Record<PeerStatus, { label: string; tone: Tone; help: string }> = {
  paired: { label: "paired", tone: "ok", help: "answering, and the answer verified" },
  pending: { label: "pending", tone: "idle", help: "added, not yet reached" },
  // Grey, not violet: a quiet peer is a connection state, not a person being
  // waited on, and its "seen … ago" already says how old the figures are.
  stale: {
    label: "stale",
    tone: "idle",
    help: "last answer is older than five minutes — the figures below are that old",
  },
  unauthorized: {
    label: "unpaired",
    tone: "fail",
    help: "reachable, but the pairing did not verify — usually a secret typed into one machine and not the other",
  },
  unreachable: { label: "unreachable", tone: "fail", help: "no answer at all" },
};

// `StatusPill`'s anatomy, for a vocabulary it does not have.
const PILL: Record<Tone, string> = {
  ok: "border-ok/25 bg-ok/10 text-ok",
  idle: "border-line-strong bg-ink-faint/8 text-ink-dim",
  fail: "border-fail/35 bg-fail/12 text-fail",
};

function PeerPill({ status }: { status: PeerStatus }) {
  const s = STATUS_COPY[status];
  return (
    <span
      title={s.help}
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-2.5 text-caption font-semibold leading-none ${PILL[s.tone]}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {/* Lower-case in the DOM, the words the server and tests use; sentence
          case on screen, like every other pill. */}
      <span className="inline-block first-letter:uppercase">{s.label}</span>
    </span>
  );
}

/** The five counts a machine reports, as one inset well. A zero is neutral;
 *  an open issue is a failure, so it is red like the monitors beside it. The
 *  words are the fleet totals' own, shortened to fit a fifth of a card, and
 *  said in full in the tooltip. A column is never narrower than its word:
 *  equal fifths clipped the longest to "Awai…" on a phone and on a tablet's
 *  two-up cards, while "Live" beside it had room to spare, so a long word
 *  takes its width and the rest share what is left. */
function MachineCounts({ summary }: { summary: MachineSummary }) {
  const cells: { label: string; full: string; value: number; tone: string }[] = [
    { label: "Down", full: "Monitors down", value: summary.monitorsDown, tone: "text-fail" },
    {
      label: "Failing",
      full: "Monitors failing",
      value: summary.monitorsFailing,
      tone: "text-fail",
    },
    { label: "Issues", full: "Open issues", value: summary.openIssues, tone: "text-fail" },
    { label: "Live", full: "Live pipelines", value: summary.liveInstances, tone: "text-run" },
    {
      label: "Approval",
      full: "Needs approval",
      value: summary.gatedInstances,
      tone: "text-await",
    },
  ];
  return (
    <dl className="mt-3 grid grid-cols-[repeat(5,1fr)] divide-x divide-line rounded-control bg-ground-2/60">
      {cells.map((c) => (
        <div key={c.label} title={c.full} className="flex flex-col-reverse px-2 py-2 sm:px-3">
          <dt className="whitespace-nowrap text-micro font-semibold text-ink-faint">{c.label}</dt>
          <dd
            className={`text-title font-semibold leading-tight ${c.value === 0 ? "text-ink-faint" : c.tone}`}
          >
            {c.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Where a machine sits in the list: the ones that need a look first — no
 * answer, a failed pairing, monitors down or failing, a critical incident —
 * then those with a gate waiting on someone, then the rest. This machine
 * always leads, as the reference the others are read against.
 */
function rank(m: FleetMachine): number {
  if (m.isSelf) return -1;
  const s = m.summary;
  if (
    STATUS_COPY[m.peer.status].tone === "fail" ||
    (s != null &&
      (s.monitorsDown > 0 ||
        s.monitorsFailing > 0 ||
        (s.worstIncident != null && /^critical\b/i.test(s.worstIncident))))
  )
    return 0;
  if (s != null && s.gatedInstances > 0) return 1;
  return 2;
}

function byAttention(a: FleetMachine, b: FleetMachine): number {
  return (
    rank(a) - rank(b) ||
    (a.summary?.label ?? a.peer.label).localeCompare(b.summary?.label ?? b.peer.label)
  );
}

function MachineCard({ machine, onUnpair }: { machine: FleetMachine; onUnpair: () => void }) {
  const { peer, summary, isSelf } = machine;
  const tone = isSelf ? null : STATUS_COPY[peer.status].tone;
  const name = summary?.label ?? peer.label;
  const critical = summary?.worstIncident != null && /^critical\b/i.test(summary.worstIncident);
  return (
    <Card className="relative overflow-hidden">
      {tone === "fail" && (
        <span
          aria-hidden="true"
          className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-fail"
        />
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="min-w-0 truncate text-heading font-semibold text-ink">{name}</span>
        {isSelf ? (
          <span className={chipClass()}>
            <span className="inline-block first-letter:uppercase">this machine</span>
          </span>
        ) : (
          <PeerPill status={peer.status} />
        )}
        {!isSelf && (
          <span className="ml-auto flex items-center gap-2">
            {peer.lastSeenAt && (
              <span className="text-caption text-ink-faint">
                seen <TimeAgo iso={peer.lastSeenAt} />
              </span>
            )}
            {/* Destructive and immediate, but quiet until reached for: three red
                outlines on a board read as three failures. Red only on hover, and
                named for its machine, since every card has one. */}
            <Button
              size="sm"
              variant="quiet-danger"
              icon="trash"
              title={`Unpair ${name}`}
              aria-label={`unpair ${name}`}
              onClick={onUnpair}
            >
              <span className="inline-block first-letter:uppercase">unpair</span>
            </Button>
          </span>
        )}
      </div>

      {!isSelf && (
        <p className="mt-0.5 truncate font-mono text-caption text-ink-faint" title={peer.url}>
          {peer.url}
        </p>
      )}

      {summary ? (
        <>
          <MachineCounts summary={summary} />
          {/* One run of text rather than flex items, so a narrow card wraps it
              between words instead of stranding a separator at a line's start. */}
          <p className="mt-2.5 text-caption text-ink-faint">
            <span className="text-ink-dim">{summary.runsToday}</span> run
            {summary.runsToday === 1 ? "" : "s"} today
            {summary.failuresToday > 0 && (
              <span className="font-semibold text-fail"> · {summary.failuresToday} failed</span>
            )}{" "}
            · <span className="text-ink-dim">{formatUsd(summary.spendTodayUsd)}</span> today ·{" "}
            <span className="text-ink-dim">{formatUsd(summary.spendMonthUsd)}</span> this month · v
            {summary.version}
          </p>
          {/* An incident is a failure, not a wait: red when critical, quiet
              otherwise. The server's "severity: title" gets its capital here. */}
          {summary.worstIncident && (
            <p
              className={`mt-2 flex items-start gap-2 text-caption ${critical ? "text-fail-ink" : "text-ink-dim"}`}
            >
              <Icon
                name="alert"
                size={14}
                className={`mt-px ${critical ? "text-fail" : "text-ink-faint"}`}
              />
              {/* The incident lives on the machine that has it: this one's Issues
                  page, or the peer's own Argus. */}
              <a
                href={isSelf ? "#/issues" : `${peer.url.replace(/\/+$/, "")}/#/issues`}
                className="min-w-0 break-words underline decoration-line-strong underline-offset-2 transition-colors duration-(--duration-quick) first-letter:uppercase hover:decoration-current"
              >
                {summary.worstIncident}
              </a>
            </p>
          )}
        </>
      ) : (
        <p className="mt-3 flex items-start gap-2 rounded-control bg-ground-2/60 px-3 py-2.5 text-caption text-ink-dim">
          <Icon
            name={peer.status === "unauthorized" ? "shield" : "info"}
            size={14}
            className="mt-px text-ink-faint"
          />
          <span className="min-w-0 first-letter:uppercase">
            {/* The server's reason is a clause; it gets the capital and the full
                stop a sentence needs. */}
            {peer.error ? `${peer.error.replace(/[.!?]$/, "")}.` : "No summary yet."}{" "}
            {peer.status === "unauthorized" &&
              "Both machines need the same pairing secret — mint one here and add it on both sides."}
          </span>
        </p>
      )}
    </Card>
  );
}

/** One step of pairing: a number, what to do, and the controls to do it. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-caption font-semibold text-ink-dim"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-heading font-semibold text-ink">{title}</h3>
        <div className="mt-1.5">{children}</div>
      </div>
    </li>
  );
}

function PairingSecret({ secret, instructions }: { secret: string; instructions: string }) {
  const [copied, setCopied] = useState(false);
  // Only offered where the browser will actually do it (a secure context).
  const canCopy = typeof navigator !== "undefined" && navigator.clipboard != null;
  return (
    <div className="mt-3">
      <div className="flex items-start gap-2 rounded-control border border-line bg-ground-2 px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-caption leading-relaxed text-ink">
          {secret}
        </code>
        {canCopy && (
          <IconButton
            size="sm"
            icon={copied ? "check" : "copy"}
            label={copied ? "Copied" : "Copy secret"}
            onClick={() => {
              void navigator.clipboard.writeText(secret).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          />
        )}
      </div>
      <p className="mt-2 max-w-prose text-caption text-ink-faint">
        {instructions} It is shown once and not stored anywhere you can read it back.
      </p>
    </div>
  );
}

export default function Fleet() {
  const {
    fleet,
    loading,
    error,
    refresh,
    busy,
    actionError,
    pairing,
    clearPairing,
    mintPairing,
    addPeer,
    unpair,
    rename,
  } = useFleet();
  const [form, setForm] = useState({ label: "", url: "", secret: "" });
  const [name, setName] = useState("");

  const self = fleet.machines.find((m) => m.isSelf);
  const formReady = form.label.trim() !== "" && form.url.trim() !== "" && form.secret.trim() !== "";
  const t = fleet.totals;
  const partial = t.reporting < t.machines;

  // Screen-reader parity with the board: a page whose numbers change under a
  // poll has to say so, or the change is visible only to people watching it.
  const announcement = fleet.soloMode
    ? ""
    : `${t.reporting} of ${t.machines} machines reporting` +
      (t.monitorsDown > 0 ? `, ${t.monitorsDown} monitors down` : "") +
      (t.gatedInstances > 0 ? `, ${t.gatedInstances} awaiting approval` : "");

  return (
    <Page
      title="Fleet"
      subtitle={
        <>
          Every machine running Argus, in one lens.
          {/* A line of its own at the left edge, so the explanation opens into
              the page at every width rather than off the side of a phone. */}
          <span className="mt-1 block">
            <InfoTip
              title="About the fleet"
              trigger={<span className="text-caption text-ink-faint">How the fleet talks</span>}
            >
              Summaries are pulled from each peer, encrypted and signed end-to-end with a secret the
              two of you share — no server, no account, nothing to host.
            </InfoTip>
          </span>
        </>
      }
    >
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>

      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Fleet"
            message={loadError("the fleet", error)}
            action={
              <Button size="sm" icon="retry" onClick={() => refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}
      {actionError && (
        <div className="mb-6">
          <AlertStrip subject="Pairing" message={actionError} />
        </div>
      )}

      {!fleet.soloMode && (
        <Section title="Across the fleet">
          {/* Five tiles in pairs on a phone: the odd one out takes the full row
              rather than leaving a hole beside it. */}
          <div className="grid grid-cols-2 gap-3 max-sm:[&>:last-child]:col-span-2 sm:grid-cols-3 lg:grid-cols-5">
            <HealthCounter label="Monitors down" value={t.monitorsDown} tone="fail" />
            <HealthCounter label="Monitors failing" value={t.monitorsFailing} tone="fail" />
            <HealthCounter label="Open issues" value={t.openIssues} tone="fail" />
            {/* The Command Center's word for the same count: instances with
                work in flight, which it lists as "live pipelines". */}
            <HealthCounter label="Live pipelines" value={t.liveInstances} tone="run" />
            <HealthCounter label="Needs approval" value={t.gatedInstances} tone="await" />
          </div>
          <div className="mt-3 flex flex-col gap-1.5 text-caption sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-6">
            {/* A total summed over some of the machines is not a fleet total, and
                the day one goes quiet is the day that matters. */}
            <p
              className={`flex items-start gap-1.5 ${partial ? "font-semibold text-await-ink" : "text-ink-dim"}`}
            >
              <Icon
                name={partial ? "alert" : "check-circle"}
                size={14}
                className={`mt-px ${partial ? "text-await" : "text-ink-faint"}`}
              />
              <span>
                {partial
                  ? `From ${t.reporting} of ${t.machines} machines — the rest are not reporting, so these are lower bounds.`
                  : `From all ${t.machines} machines.`}
              </span>
            </p>
            <p className="text-ink-faint">
              <span className="text-ink-dim">{formatUsd(t.spendTodayUsd)}</span> today ·{" "}
              <span className="text-ink-dim">{formatUsd(t.spendMonthUsd)}</span> this month ·{" "}
              <span className="text-ink-dim">{t.runsToday}</span> run
              {t.runsToday === 1 ? "" : "s"} today
            </p>
          </div>
        </Section>
      )}

      {/* After a failed load the fleet is unknown, not empty: an empty section,
          or "no peers yet", would be a claim nobody checked. */}
      {!(error && !loading && fleet.machines.length === 0) && (
        <Section
          title={
            fleet.soloMode && !(loading && fleet.machines.length === 0)
              ? "This machine"
              : "Machines"
          }
        >
          {loading && fleet.machines.length === 0 ? (
            <>
              <p className="mb-3 text-caption text-ink-faint">Reading the fleet…</p>
              <SkeletonGrid count={2} columns={2} lines={3} />
            </>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {[...fleet.machines].sort(byAttention).map((m) => (
                <MachineCard key={m.peer.id} machine={m} onUnpair={() => void unpair(m.peer.id)} />
              ))}
            </div>
          )}
          {/* Solo is also the shape of "nothing loaded yet"; only say it once
            the fleet has actually answered. */}
          {fleet.soloMode && !(loading && fleet.machines.length === 0) && (
            <div className="mt-4 flex flex-col gap-3 rounded-tile border border-line bg-surface/50 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
              <Icon name="link" size={18} className="hidden text-ink-faint sm:block" />
              {/* No button: pairing is the very next section on the page. */}
              <p className="min-w-0 flex-1 text-small text-ink-dim">
                No peers yet, and nothing is being published. Federation is entirely opt-in: with no
                peers configured Argus makes no outbound requests and answers no summary.
              </p>
            </div>
          )}
        </Section>
      )}

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Section title="Pair a machine">
          <Card>
            <ol className="flex flex-col gap-6">
              <Step n={1} title="Mint a pairing secret">
                <p className="max-w-prose text-small text-ink-dim">
                  Pairing is mutual: both machines hold the same secret, and each side only answers
                  to pairings it holds.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button icon="shield" onClick={() => void mintPairing()} disabled={busy}>
                    Mint a pairing secret
                  </Button>
                  {pairing && (
                    <Button variant="ghost" onClick={clearPairing}>
                      Hide
                    </Button>
                  )}
                </div>
                {pairing && (
                  <PairingSecret
                    key={pairing.secret}
                    secret={pairing.secret}
                    instructions={pairing.instructions}
                  />
                )}
              </Step>

              <Step n={2} title="Add the other machine here">
                <form
                  className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(0,1.3fr)_auto]"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addPeer(form).then(() => setForm({ label: "", url: "", secret: "" }));
                  }}
                >
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className={labelClass}>Name</span>
                    <input
                      value={form.label}
                      onChange={(e) => setForm({ ...form, label: e.target.value })}
                      placeholder="Build box"
                      className={`${fieldClass} h-9 w-full`}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5">
                    <span className={labelClass}>URL</span>
                    <input
                      value={form.url}
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                      placeholder="http://box.local:7777"
                      className={`${fieldClass} h-9 w-full`}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1.5 sm:col-span-2 xl:col-span-1">
                    <span className={labelClass}>Pairing secret</span>
                    <input
                      value={form.secret}
                      onChange={(e) => setForm({ ...form, secret: e.target.value })}
                      placeholder="64 hex characters"
                      className={`${fieldClass} h-9 w-full font-mono`}
                    />
                  </label>
                  {/* Primary only once it can be pressed: a disabled solid button is
                      the heaviest thing in the card, louder than step one. */}
                  <Button
                    type="submit"
                    variant={formReady ? "primary" : "secondary"}
                    icon="plus"
                    className="h-9 justify-self-start"
                    disabled={busy || !formReady}
                  >
                    Add peer
                  </Button>
                </form>
              </Step>

              <Step n={3} title="Add this machine over there">
                <p className="max-w-prose text-small text-ink-dim">
                  On the other machine&apos;s Fleet page, add this one with the same secret. Until
                  both sides hold it, each shows the other as unpaired.
                </p>
              </Step>
            </ol>
          </Card>
        </Section>

        <Section title="This machine's name">
          <Card>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void rename(name).then(() => setName(""));
              }}
            >
              <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
                {/* The current name only once it has been read: "unnamed" while
                    loading, or after a failed load, would be a guess. */}
                <span className={labelClass}>
                  Shown to peers
                  {self?.summary && (
                    <>
                      {" "}
                      — currently{" "}
                      <strong className="text-ink">{self.summary.label || "unnamed"}</strong>
                    </>
                  )}
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Laptop"
                  className={`${fieldClass} h-9 w-full`}
                />
              </label>
              <Button type="submit" className="h-9" disabled={busy || !name.trim()}>
                Rename
              </Button>
            </form>
            <p className="mt-3 max-w-prose text-caption text-ink-faint">
              A name you choose, not your hostname. The machine&apos;s identity is a random id
              minted locally, so nothing about this computer travels to a peer that you did not type
              here.
            </p>
          </Card>
        </Section>
      </div>
    </Page>
  );
}
