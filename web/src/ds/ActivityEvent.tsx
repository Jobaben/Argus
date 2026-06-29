import type { ReactNode } from "react";

export function ActivityEvent({
  time,
  children,
}: {
  time: string;
  children: ReactNode;
  tone?: "default" | "ok" | "fail";
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-2.5">
      <span className="pt-px font-mono text-[11px] text-ink-faint">{time}</span>
      <span className="text-[13px] leading-snug text-ink-dim">{children}</span>
    </div>
  );
}
