import { STATUS, type DsStatus, type ColorToken } from "./status";

const PILL: Record<ColorToken, string> = {
  run: "text-run bg-run/12",
  ok: "text-ok bg-ok/12",
  fail: "text-fail bg-fail/14",
  queue: "text-queue bg-queue/12",
  idle: "text-idle bg-idle/12",
  await: "text-await bg-await/14",
};

const SIZE = {
  md: "gap-1.5 px-3 py-1 text-[11px] tracking-[0.13em]",
  sm: "gap-1 px-1.5 py-0.5 text-[9px] tracking-[0.1em]",
} as const;

const DOT = {
  md: "h-1.5 w-1.5 shadow-[0_0_8px_1px_currentColor]",
  sm: "h-1 w-1 shadow-[0_0_6px_1px_currentColor]",
} as const;

export function StatusPill({
  status,
  size = "md",
}: {
  status: DsStatus;
  size?: keyof typeof SIZE;
}) {
  const { token, label } = STATUS[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border border-current font-mono font-bold uppercase ${SIZE[size]} ${PILL[token]}`}
    >
      {status === "await" && (
        <span
          className={`animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-current ${DOT[size]}`}
        />
      )}
      {label}
    </span>
  );
}
