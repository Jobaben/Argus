import type { ReactNode } from "react";

const TONE = {
  default: "[&_b]:text-ink",
  ok: "[&_b]:text-ok",
  fail: "[&_b]:text-fail",
} as const;

export function ActivityEvent({
  time,
  tone = "default",
  children,
}: {
  time: string;
  children: ReactNode;
  tone?: keyof typeof TONE;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-2.5">
      <span className="pt-px font-mono text-[11px] text-ink-faint">{time}</span>
      <span className={`text-[13px] leading-snug text-ink-dim [&_b]:font-semibold ${TONE[tone]}`}>
        {children}
      </span>
    </div>
  );
}
