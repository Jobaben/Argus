import type { ReactNode } from "react";
import { sparklinePoints } from "./format";

const STROKE = {
  ok: "#2fe6a4",
  eye: "#36e3e8",
  run: "#ffb224",
  fail: "#ff5765",
} as const;

export function Sparkline({
  label,
  value,
  sub,
  values,
  tone = "ok",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  values: number[];
  tone?: keyof typeof STROKE;
}) {
  return (
    <div className="w-40 rounded-tile border border-line bg-ground-2 px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </div>
      <div className="mt-0.5 text-2xl font-extrabold">
        {value}
        {sub && <small className="text-[0.55em] font-semibold text-ink-faint"> {sub}</small>}
      </div>
      <svg
        viewBox="0 0 100 26"
        preserveAspectRatio="none"
        aria-hidden="true"
        className="mt-2 block h-[30px] w-full"
      >
        <polyline
          fill="none"
          stroke={STROKE[tone]}
          strokeWidth={2}
          points={sparklinePoints(values, 100, 26)}
        />
      </svg>
    </div>
  );
}
