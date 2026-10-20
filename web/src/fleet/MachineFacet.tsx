import { Fragment, useId } from "react";
import { EmptyState, Icon, TimeAgo } from "../ds";
import type { MachineFacetState } from "./useMachineFacet";

/**
 * The machine picker that the fleet-wide views share.
 *
 * Renders **nothing** in solo mode — not a disabled control, not a row with one
 * chip. A single-machine install should look exactly as it did before
 * federation existed, and a picker with one option is a feature advertising
 * itself at the cost of the page it sits on.
 *
 * Styled as the shared `SegmentedControl`, which it cannot simply be: each
 * machine carries its own reporting state, and a peer that has gone quiet stays
 * selectable — being able to look at a machine and see "it is down" is the
 * point — so it is marked with a dot and a reason rather than greyed out. The
 * dot is red only for a peer that has failed to answer; one just added and not
 * yet reached is grey, as the Fleet page draws it.
 */
export function MachinePicker({ facet, label }: { facet: MachineFacetState; label: string }) {
  const reasonId = useId();
  if (facet.soloMode || facet.machines.length < 2) return null;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="mb-4 inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-control border border-line bg-ground-2 p-0.5"
    >
      {facet.machines.map((m) => {
        const id = m.isSelf ? null : m.peer.id;
        const active = facet.selected === id;
        const reporting = m.isSelf || m.summary !== null;
        const reason = `${m.peer.label} is not reporting — ${m.peer.error ?? m.peer.status}`;
        const describedBy = `${reasonId}-${m.peer.id}`;
        return (
          <Fragment key={m.peer.id}>
            <button
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => facet.select(id)}
              title={reporting ? undefined : reason}
              aria-describedby={reporting ? undefined : describedBy}
              className={`inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-caption font-semibold transition duration-(--duration-quick) motion-safe:active:scale-[0.96] ${
                active
                  ? "bg-surface-3 text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]"
                  : "text-ink-faint hover:text-ink"
              }`}
            >
              {!reporting && (
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    m.peer.status === "pending" ? "bg-ink-faint" : "bg-fail"
                  }`}
                />
              )}
              <span className="truncate">{m.isSelf ? "This machine" : m.peer.label}</span>
            </button>
            {/* The reason, for assistive tech, as the radio's description: outside
              it so the name stays the machine's, and hidden so it is read only
              with the radio, not again on its own. */}
            {!reporting && (
              <span id={describedBy} hidden>
                {reason}
              </span>
            )}
          </Fragment>
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
    <div
      className={`mb-6 flex items-start gap-2.5 rounded-tile border px-4 py-3 text-small ${
        stale
          ? "border-await/35 bg-await/8 text-await-ink"
          : "border-line bg-surface/60 text-ink-dim"
      }`}
      role="status"
    >
      <Icon
        name={stale ? "clock" : "eye"}
        size={16}
        className={`mt-0.5 ${stale ? "text-await" : "text-ink-faint"}`}
      />
      <p className="min-w-0">
        Showing{" "}
        <strong className="font-semibold text-ink">{peer.summary?.label ?? peer.peer.label}</strong>
        {peer.summary ? (
          <>
            , as of <TimeAgo iso={peer.summary.generatedAt} />
            {stale && " — this peer has stopped answering, so these figures are frozen"}.{" "}
            {peer.peer.url && (
              <a
                href={peer.peer.url}
                className="inline-flex items-center gap-0.5 font-semibold text-ink underline decoration-line-strong underline-offset-2 transition-colors duration-(--duration-quick) hover:decoration-ink"
              >
                Open its Argus
                <Icon name="external" size={13} />
              </a>
            )}{" "}
            for anything not shown here.
          </>
        ) : (
          <> — no summary yet ({peer.peer.error ?? peer.peer.status}).</>
        )}
      </p>
    </div>
  );
}

/** What a peer view shows when the peer has sent nothing for this section. */
export function PeerEmpty({ what }: { what: string }) {
  return (
    <EmptyState compact icon="inbox" title="Nothing to show">
      That machine reported no {what}. A peer sends a bounded summary, not its whole history; open
      its own Argus for the full picture.
    </EmptyState>
  );
}
