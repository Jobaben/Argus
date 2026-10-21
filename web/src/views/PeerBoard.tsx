import { Fragment } from "react";
import { MachinePicker, PeerBanner, PeerEmpty } from "../fleet/MachineFacet";
import type { MachineFacetState } from "../fleet/useMachineFacet";
import { StatusPill, chipClass, type DsStatus } from "../ds";

/**
 * The Command Center's peer mode: the machine picker, the banner naming the
 * machine on show, and that machine's live pipelines. Its own chunk, loaded
 * once this install is paired with another, so a solo install's first paint
 * does not carry it.
 */
export function PeerControls({ facet }: { facet: MachineFacetState }) {
  return (
    <Fragment>
      <MachinePicker facet={facet} label="Show the board from" />
      <PeerBanner facet={facet} />
    </Fragment>
  );
}

/**
 * A peer's instance status, read through the same table as this board's own.
 * Everything that was not a gate used to be painted the running colour, so a
 * peer's failed pipeline wore an amber "Failed" beside the amber "Running".
 */
const PEER_STATUS = new Map<string, DsStatus>([
  ["running", "working"],
  ["awaiting-approval", "await"],
  ["failed", "failed"],
  ["succeeded", "done"],
  ["aborted", "stopped"],
]);

/** A status this build has no word for: a free string from another machine,
 *  so it is only cased, not translated, and stays the neutral colour. */
function peerStatusLabel(status: string): string {
  const words = status.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A peer's live pipelines.
 *
 * A card, not the board: the board's phase grid is built from step-level state
 * that a summary does not carry, and drawing an empty grid would say "no steps"
 * where the truth is "not sent". What a peer does send — which pipelines are
 * live and which phase each is at — is exactly the question the board answers
 * at a glance, so that is what this shows.
 *
 * No approve or revise buttons. A gate is opened by the machine that owns it;
 * a button here would either fail or need a second control plane across the
 * pairing, and the link out is the honest affordance.
 */
export function PeerBoard({ facet }: { facet: MachineFacetState }) {
  const pipelines = facet.peer?.summary?.facets.pipelines ?? [];
  if (pipelines.length === 0) return <PeerEmpty what="live pipelines" />;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
      {pipelines.map((p) => {
        const status = PEER_STATUS.get(p.status);
        return (
          <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
            {/* A basis, so on a phone the phase and status wrap under the
                name instead of the name being cut to make room for them. */}
            <span className="min-w-0 flex-1 basis-48 break-words text-sm font-semibold text-ink">
              {p.name}
            </span>
            {p.phase && <span className="text-caption text-ink-faint">at {p.phase}</span>}
            {status ? (
              <StatusPill status={status} size="sm" />
            ) : (
              <span className={chipClass("neutral")}>{peerStatusLabel(p.status)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
