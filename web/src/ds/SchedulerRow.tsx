import { formatDuration } from "./format";

export function SchedulerRow({
  name,
  etaMs,
  trigger,
}: {
  name: string;
  etaMs: number | null;
  trigger: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-2.5 gap-y-1">
      <div className="text-sm font-semibold">{name}</div>
      <div className="text-right font-mono text-sm font-bold text-eye">
        {etaMs == null ? "—" : formatDuration(etaMs)}
      </div>
      <div className="col-start-1 font-mono text-[11px] text-ink-faint">{trigger}</div>
    </div>
  );
}
