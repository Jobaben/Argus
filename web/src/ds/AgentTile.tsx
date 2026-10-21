import type { Agent } from "../types";
import { STATUS, toDsStatus, type DsStatus } from "./status";
import { StatusPill } from "./StatusPill";
import { SweepBar } from "./SweepBar";
import { TimeAgo } from "./TimeAgo";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { RAIL, TILE_SKIN, TILE_DETAIL } from "./rail";

/**
 * One background agent: who it is, what state it is in, and what it is doing.
 *
 * The name and the status pill share the top line because those are what a
 * glance is for; the detail sentence is the one thing worth reading; the footer
 * is provenance, quiet on purpose. On a tile that is waiting for a human the
 * decision is the next line after the detail — Approve is the green action and
 * Revise its neutral alternative, the same ranking the gate uses everywhere.
 */
export function AgentTile({
  agent,
  dsStatusOverride,
  onApprove,
  onRevise,
}: {
  agent: Agent;
  dsStatusOverride?: DsStatus;
  onApprove?: () => void;
  onRevise?: () => void;
}) {
  const ds = dsStatusOverride ?? toDsStatus(agent.status);
  const { token } = STATUS[ds];
  const folder = agent.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;
  const inFlight = agent.inFlight && agent.inFlight.tasks > 0 ? agent.inFlight.tasks : 0;

  return (
    <div
      className={`relative flex flex-col gap-2.5 overflow-hidden rounded-tile border bg-gradient-to-b to-surface px-4 py-3.5 pl-[1.15rem] shadow-raised ${TILE_SKIN[token]}`}
    >
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${RAIL[token]}`} />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-heading font-semibold leading-tight text-ink">
            {agent.name}
          </div>
          <div className="mt-1 text-caption text-ink-faint">
            job <span className="font-mono">{agent.short}</span>
          </div>
        </div>
        <StatusPill status={ds} />
      </div>

      {agent.detail && (
        <p className={`text-small leading-snug ${TILE_DETAIL[token] ?? "text-ink-dim"}`}>
          {agent.detail}
        </p>
      )}

      {ds === "working" && <SweepBar />}

      {ds === "await" && (onApprove || onRevise) && (
        <div className="flex gap-2">
          <Button variant="approve" size="sm" icon="check" onClick={onApprove} className="flex-1">
            Approve
          </Button>
          <Button variant="secondary" size="sm" icon="edit" onClick={onRevise} className="flex-1">
            Revise
          </Button>
        </div>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-faint">
        {agent.live && (
          <span className="inline-flex items-center gap-1.5 text-eye">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
            Live
          </span>
        )}
        {folder && (
          <span className="inline-flex min-w-0 items-center gap-1.5" title={agent.cwd ?? undefined}>
            <Icon name="folder" size={13} />
            <span className="truncate font-mono">{folder}</span>
          </span>
        )}
        {inFlight > 0 && <span className="text-run">{inFlight} in flight</span>}
        <span className="ml-auto">
          <TimeAgo iso={agent.updatedAt} />
        </span>
      </div>
    </div>
  );
}
