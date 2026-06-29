import { STATUS, type DsStatus, type ColorToken } from "./status";

const PILL: Record<ColorToken, string> = {
  run: "text-run bg-run/12",
  ok: "text-ok bg-ok/12",
  fail: "text-fail bg-fail/14",
  queue: "text-queue bg-queue/12",
  idle: "text-idle bg-idle/12",
  await: "text-await bg-await/14",
};

export function StatusPill({ status }: { status: DsStatus }) {
  const { token, label } = STATUS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-current px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.13em] ${PILL[token]}`}
    >
      {status === "await" && (
        <span className="h-1.5 w-1.5 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-current shadow-[0_0_8px_1px_currentColor]" />
      )}
      {label}
    </span>
  );
}
