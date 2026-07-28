import { useState } from "react";
import {
  AlertStrip,
  Card,
  EmptyState,
  HealthCounter,
  Page,
  Section,
  TimeAgo,
  formatUsd,
} from "../ds";
import { useFleet } from "../useFleet";
import type { FleetMachine, PeerStatus } from "../types";

/**
 * Constellation's page: N machines, one lens.
 *
 * The design problem here is not the list, it is the totals. A number summed
 * over three of five machines is not a fleet number, so the header says how
 * many machines are reporting next to every figure it adds up — and a machine
 * that has gone quiet keeps its last card, marked, rather than disappearing and
 * quietly shrinking the denominator.
 */

const STATUS_COPY: Record<PeerStatus, { label: string; tone: string; help: string }> = {
  paired: { label: "paired", tone: "text-ok", help: "answering, and the answer verified" },
  pending: { label: "pending", tone: "text-ink-faint", help: "added, not yet reached" },
  stale: {
    label: "stale",
    tone: "text-await",
    help: "last answer is older than five minutes — the figures below are that old",
  },
  unauthorized: {
    label: "unpaired",
    tone: "text-fail",
    help: "reachable, but the pairing did not verify — usually a secret typed into one machine and not the other",
  },
  unreachable: { label: "unreachable", tone: "text-fail", help: "no answer at all" },
};

function MachineCard({ machine, onUnpair }: { machine: FleetMachine; onUnpair: () => void }) {
  const { peer, summary, isSelf } = machine;
  const status = STATUS_COPY[peer.status];
  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-ink">{summary?.label ?? peer.label}</span>
        {isSelf ? (
          <span className="rounded-full bg-eye/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-eye">
            this machine
          </span>
        ) : (
          <span
            className={`font-mono text-[10px] uppercase tracking-[0.12em] ${status.tone}`}
            title={status.help}
          >
            {status.label}
          </span>
        )}
        {!isSelf && peer.lastSeenAt && (
          <span className="font-mono text-[10px] text-ink-faint">
            seen <TimeAgo iso={peer.lastSeenAt} />
          </span>
        )}
        {!isSelf && (
          <button
            type="button"
            onClick={onUnpair}
            className="ml-auto font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint hover:text-fail"
          >
            unpair
          </button>
        )}
      </div>

      {!isSelf && <p className="mt-0.5 font-mono text-[10px] text-ink-faint">{peer.url}</p>}

      {summary ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <HealthCounter label="down" value={summary.monitorsDown} tone="fail" />
            <HealthCounter label="failing" value={summary.monitorsFailing} tone="queue" />
            <HealthCounter label="issues" value={summary.openIssues} tone="queue" />
            <HealthCounter label="running" value={summary.liveInstances} tone="run" />
            <HealthCounter label="gated" value={summary.gatedInstances} tone="queue" />
          </div>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            {summary.runsToday} run{summary.runsToday === 1 ? "" : "s"} today
            {summary.failuresToday > 0 && (
              <span className="text-fail"> · {summary.failuresToday} failed</span>
            )}{" "}
            · {formatUsd(summary.spendTodayUsd)} today · {formatUsd(summary.spendMonthUsd)} this
            month · v{summary.version}
          </p>
          {summary.worstIncident && (
            <p className="mt-1 text-xs text-await">{summary.worstIncident}</p>
          )}
        </>
      ) : (
        <p className="mt-3 text-xs text-ink-faint">
          {peer.error ?? "No summary yet."}{" "}
          {peer.status === "unauthorized" &&
            "Both machines need the same pairing secret — mint one here and add it on both sides."}
        </p>
      )}
    </Card>
  );
}

export default function Fleet() {
  const {
    fleet,
    loading,
    error,
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
  const t = fleet.totals;
  const partial = t.reporting < t.machines;

  return (
    <Page title="Fleet">
      <p className="mb-6 max-w-prose text-sm text-ink-faint">
        Every machine running Argus, in one lens. Summaries are pulled from each peer, encrypted and
        signed end-to-end with a secret the two of you share — no server, no account, nothing to
        host.
      </p>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't reach the Argus server: ${error}`} />
        </div>
      )}
      {actionError && (
        <div className="mb-6">
          <AlertStrip subject="Pairing" message={actionError} />
        </div>
      )}

      {!fleet.soloMode && (
        <Section title="Across the fleet">
          <Card>
            <div className="flex flex-wrap gap-2">
              <HealthCounter label="down" value={t.monitorsDown} tone="fail" />
              <HealthCounter label="failing" value={t.monitorsFailing} tone="queue" />
              <HealthCounter label="issues" value={t.openIssues} tone="queue" />
              <HealthCounter label="running" value={t.liveInstances} tone="run" />
              <HealthCounter label="gated" value={t.gatedInstances} tone="queue" />
            </div>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              {formatUsd(t.spendTodayUsd)} today · {formatUsd(t.spendMonthUsd)} this month ·{" "}
              {t.runsToday} run{t.runsToday === 1 ? "" : "s"}
            </p>
            {/* A total summed over some of the machines is not a fleet total, and
                the day one goes quiet is the day that matters. */}
            <p className={`mt-1 text-xs ${partial ? "text-await" : "text-ink-faint"}`}>
              {partial
                ? `From ${t.reporting} of ${t.machines} machines — the rest are not reporting, so these are lower bounds.`
                : `From all ${t.machines} machines.`}
            </p>
          </Card>
        </Section>
      )}

      <Section title={fleet.soloMode ? "This machine" : "Machines"}>
        {loading && fleet.machines.length === 0 ? (
          <EmptyState>Reading the fleet…</EmptyState>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {fleet.machines.map((m) => (
              <MachineCard key={m.peer.id} machine={m} onUnpair={() => void unpair(m.peer.id)} />
            ))}
          </div>
        )}
        {fleet.soloMode && (
          <p className="mt-3 max-w-prose text-xs text-ink-faint">
            No peers yet, and nothing is being published. Federation is entirely opt-in: with no
            peers configured Argus makes no outbound requests and answers no summary.
          </p>
        )}
      </Section>

      <Section title="Pair a machine">
        <Card>
          <p className="max-w-prose text-sm text-ink-dim">
            Pairing is mutual. Mint a secret here, then add the <em>other</em> machine on this page
            using it — and add <em>this</em> machine on that one, with the same secret. Each side
            only answers to pairings it holds.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void mintPairing()}
              disabled={busy}
              className="rounded-md border border-eye/40 bg-eye/10 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-eye transition hover:bg-eye/20 disabled:opacity-50"
            >
              Mint a pairing secret
            </button>
            {pairing && (
              <button
                type="button"
                onClick={clearPairing}
                className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-faint hover:text-ink"
              >
                Hide
              </button>
            )}
          </div>

          {pairing && (
            <div className="mt-3">
              <code className="block break-all rounded-md border border-line bg-ground-2 px-2 py-1.5 font-mono text-[11px] text-ink">
                {pairing.secret}
              </code>
              <p className="mt-1 max-w-prose text-xs text-ink-faint">
                {pairing.instructions} It is shown once and not stored anywhere you can read it
                back.
              </p>
            </div>
          )}

          <form
            className="mt-4 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addPeer(form).then(() => setForm({ label: "", url: "", secret: "" }));
            }}
          >
            <label className="text-xs text-ink-dim">
              <span className="mb-1 block">Name</span>
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="Build box"
                className="w-36 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
              />
            </label>
            <label className="text-xs text-ink-dim">
              <span className="mb-1 block">URL</span>
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="http://box.local:7777"
                className="w-56 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
              />
            </label>
            <label className="text-xs text-ink-dim">
              <span className="mb-1 block">Pairing secret</span>
              <input
                value={form.secret}
                onChange={(e) => setForm({ ...form, secret: e.target.value })}
                placeholder="64 hex characters"
                className="w-64 rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !form.label.trim() || !form.url.trim() || !form.secret.trim()}
              className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-50"
            >
              Add peer
            </button>
          </form>
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
            <label className="text-xs text-ink-dim">
              <span className="mb-1 block">
                Shown to peers — currently{" "}
                <strong className="text-ink">{self?.summary?.label ?? "unnamed"}</strong>
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Laptop"
                className="w-48 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-50"
            >
              Rename
            </button>
          </form>
          <p className="mt-2 max-w-prose text-xs text-ink-faint">
            A name you choose, not your hostname. The machine&apos;s identity is a random id minted
            locally, so nothing about this computer travels to a peer that you did not type here.
          </p>
        </Card>
      </Section>
    </Page>
  );
}
