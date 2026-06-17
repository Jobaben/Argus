import type { ReactNode } from "react";

export type Status =
  | "working"
  | "done"
  | "failed"
  | "idle"
  | "queued"
  | "unknown";

const STATUS_STYLE: Record<Status, string> = {
  working: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  done: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  idle: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  queued: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  unknown: "bg-slate-500/15 text-slate-400 ring-slate-500/30",
};

export function StatusPill({ status }: { status: Status | string }) {
  const style = STATUS_STYLE[status as Status] ?? STATUS_STYLE.unknown;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide ring-1 ${style}`}
    >
      {status}
    </span>
  );
}

export function Stat({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2">
      <div className="text-2xl font-semibold text-white">{value}</div>
      <div className="text-xs uppercase tracking-wide text-white/40">{label}</div>
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-white/20 hover:bg-white/[0.05] ${className}`}
    >
      {children}
    </div>
  );
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function TimeAgo({ iso }: { iso: string | null | undefined }) {
  const label = relativeTime(iso);
  const title = iso ?? undefined;
  return (
    <span className="text-white/40" title={title}>
      {label}
    </span>
  );
}

export function Section({
  title,
  children,
  className = "",
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mb-8 ${className}`}>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-white/40">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
      {children}
    </div>
  );
}
