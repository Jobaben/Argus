import type { ReactNode } from "react";

const TONE = {
  ink: "text-ink",
  run: "text-run",
  fail: "text-fail",
  live: "text-eye",
} as const;

export function HealthCounter({
  label,
  value,
  tone = "ink",
}: {
  label: string;
  value: ReactNode;
  tone?: keyof typeof TONE;
}) {
  return (
    <div className="rounded-tile border border-line bg-ground-2 px-5 py-3.5 text-center">
      <div className={`text-4xl font-extrabold leading-none ${TONE[tone]}`}>
        {value}
      </div>
      <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        {label}
      </div>
    </div>
  );
}
