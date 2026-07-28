import { TimeAgo } from "../ds";
import type { MachineFacetState } from "./useMachineFacet";

/**
 * The machine picker that the fleet-wide views share.
 *
 * Renders **nothing** in solo mode — not a disabled control, not a row with one
 * chip. A single-machine install should look exactly as it did before
 * federation existed, and a picker with one option is a feature advertising
 * itself at the cost of the page it sits on.
 */
export function MachinePicker({ facet, label }: { facet: MachineFacetState; label: string }) {
  if (facet.soloMode || facet.machines.length < 2) return null;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="mb-3 inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-line bg-ground-2 p-0.5"
    >
      {facet.machines.map((m) => {
        const id = m.isSelf ? null : m.peer.id;
        const active = facet.selected === id;
        const reporting = m.isSelf || m.summary !== null;
        return (
          <button
            key={m.peer.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => facet.select(id)}
            title={
              reporting
                ? undefined
                : `${m.peer.label} is not reporting — ${m.peer.error ?? m.peer.status}`
            }
            className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition ${
              active ? "bg-surface-2 text-ink" : "text-ink-faint hover:text-ink-dim"
            } ${reporting ? "" : "opacity-50"}`}
          >
            {m.isSelf ? "This machine" : m.peer.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The banner above peer content.
 *
 * Every fleet-wide view needs to say the same three things when it is showing
 * somewhere else: whose data this is, how old it is, and that the detail lives
 * on that machine. Saying them the same way everywhere is the point of putting
 * it here.
 */
export function PeerBanner({ facet }: { facet: MachineFacetState }) {
  const peer = facet.peer;
  if (!peer) return null;
  const stale = peer.peer.status === "stale";
  return (
    <p
      className={`mb-3 rounded-tile border px-3 py-2 text-xs ${
        stale ? "border-await/40 text-await" : "border-line text-ink-faint"
      }`}
      role="status"
    >
      Showing <strong className="text-ink">{peer.summary?.label ?? peer.peer.label}</strong>
      {peer.summary ? (
        <>
          , as of <TimeAgo iso={peer.summary.generatedAt} />
          {stale && " — this peer has stopped answering, so these figures are frozen"}.{" "}
          {peer.peer.url && (
            <a href={peer.peer.url} className="text-eye hover:underline">
              Open its Argus
            </a>
          )}{" "}
          for anything not shown here.
        </>
      ) : (
        <> — no summary yet ({peer.peer.error ?? peer.peer.status}).</>
      )}
    </p>
  );
}

/** What a peer view shows when the peer has sent nothing for this section. */
export function PeerEmpty({ what }: { what: string }) {
  return (
    <p className="rounded-tile border border-line bg-surface px-3 py-6 text-center text-sm text-ink-faint">
      Nothing to show — that machine reported no {what}. A peer sends a bounded summary, not its
      whole history; open its own Argus for the full picture.
    </p>
  );
}
