import type { Agent } from "../types";
import { STATUS, toDsStatus, type DsStatus } from "./status";
import { StatusPill } from "./StatusPill";
import { TimeAgo } from "./TimeAgo";
import { RAIL } from "./rail";

const SKIN: Record<DsStatus, string> = {
  working: "border-run/30 from-surface-2",
  done: "border-line from-surface-2",
  failed: "border-fail/40 from-fail/10",
  queued: "border-line from-surface-2",
  idle: "border-line from-surface-2",
  await: "border-await/42 from-await/12",
};

const DETAIL: Partial<Record<DsStatus, string>> = {
  failed: "text-[#ffc4ca]",
  await: "text-[#dcc8ff]",
};

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

  return (
    <div
      className={`relative flex flex-col gap-2 overflow-hidden rounded-tile border bg-gradient-to-b to-surface px-3.5 py-3 pl-4 ${SKIN[ds]}`}
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${RAIL[token]}`} />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold leading-tight">{agent.name}</div>
          <div className="mt-0.5 font-mono text-[10.5px] text-ink-faint">job {agent.short}</div>
        </div>
        <StatusPill status={ds} />
      </div>

      {agent.detail && (
        <div className={`text-[12.5px] leading-snug ${DETAIL[ds] ?? "text-ink-dim"}`}>
          {agent.detail}
        </div>
      )}

      {ds === "working" && (
        <div className="relative h-[5px] overflow-hidden rounded-full bg-ink-faint/15">
          <i className="absolute inset-y-0 w-2/5 animate-[sweep_1.6s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-transparent via-run to-transparent" />
        </div>
      )}

      {ds === "await" && (onApprove || onRevise) && (
        <div className="mt-px flex gap-1.5">
          <button
            type="button"
            onClick={onApprove}
            className="flex-1 rounded-md border border-ok bg-ok/10 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ok"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={onRevise}
            className="flex-1 rounded-md border border-await bg-await/10 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-await"
          >
            Revise
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 font-mono text-[10px] text-ink-faint">
        {agent.live && <span className="text-eye">● live</span>}
        {folder && <span>{folder}</span>}
        {agent.inFlight && agent.inFlight.tasks > 0 && (
          <span className="text-run/80">{agent.inFlight.tasks} in flight</span>
        )}
        <span className="ml-auto">
          <TimeAgo iso={agent.updatedAt} />
        </span>
      </div>
    </div>
  );
}
