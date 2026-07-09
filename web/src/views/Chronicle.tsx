import { useMemo, useState } from "react";
import { useChronicle } from "../useChronicle";
import type { ChronicleGroup, ChronicleKind, ChronicleSpan, ChronicleStatus } from "../types";
import { EmptyState, HealthCounter, Page, SegmentedControl, formatUsd } from "../ds";
import { axisTicks, spanGeometry } from "../ds/chronicleLayout";

const WINDOWS = [
  { value: "1", label: "1h" },
  { value: "6", label: "6h" },
  { value: "24", label: "24h" },
  { value: "72", label: "3d" },
  { value: "168", label: "7d" },
] as const;

type WindowValue = (typeof WINDOWS)[number]["value"];

// Static class maps — Tailwind can't see dynamically-built class names.
const BAR: Record<ChronicleStatus, string> = {
  working: "bg-run/25 border-run/60 text-run",
  done: "bg-ok/20 border-ok/50 text-ok",
  failed: "bg-fail/25 border-fail/60 text-fail",
  queued: "bg-queue/20 border-queue/50 text-queue",
  idle: "bg-idle/15 border-idle/40 text-idle",
};

const KIND_LABEL: Record<ChronicleKind, string> = {
  run: "SCHED",
  agent: "AGENT",
  session: "SESSION",
};

const KIND_BADGE: Record<ChronicleKind, string> = {
  run: "text-queue bg-queue/12",
  agent: "text-eye bg-eye/12",
  session: "text-await bg-await/12",
};

function spanTitle(span: ChronicleSpan): string {
  const start = new Date(span.startedAt).toLocaleString();
  const end = span.endedAt ? new Date(span.endedAt).toLocaleString() : "now";
  const parts = [`${span.label}`, `${start} → ${end}`, span.status];
  if (span.detail) parts.push(span.detail);
  if (span.costUsd != null) parts.push(formatUsd(span.costUsd));
  return parts.join("\n");
}

function SpanBar({
  span,
  windowStartMs,
  windowEndMs,
}: {
  span: ChronicleSpan;
  windowStartMs: number;
  windowEndMs: number;
}) {
  const geo = spanGeometry(span.startedAt, span.endedAt, windowStartMs, windowEndMs);
  if (!geo) return null;
  const wide = geo.width > 7;
  const body = (
    <>
      {geo.openEnded && (
        <span
          aria-hidden
          className="absolute right-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-current shadow-[0_0_8px_1px_currentColor]"
        />
      )}
      {wide && <span className="truncate px-1.5 text-[10px] font-semibold">{span.label}</span>}
    </>
  );
  const cls = `absolute inset-y-0.5 flex items-center overflow-hidden rounded border ${BAR[span.status]} ${
    geo.openEnded ? "rounded-r-none border-r-0" : ""
  }`;
  const style = { left: `${geo.left}%`, width: `${geo.width}%` };
  return span.href ? (
    <a
      href={span.href}
      title={spanTitle(span)}
      aria-label={`${span.label}, ${span.status}`}
      className={`${cls} transition hover:brightness-125`}
      style={style}
    >
      {body}
    </a>
  ) : (
    <div title={spanTitle(span)} className={cls} style={style}>
      {body}
    </div>
  );
}

function GroupLanes({
  group,
  windowStartMs,
  windowEndMs,
}: {
  group: ChronicleGroup;
  windowStartMs: number;
  windowEndMs: number;
}) {
  return (
    <div className="flex border-t border-line/60">
      <div className="w-44 shrink-0 py-1.5 pr-3">
        <span
          className={`mr-1.5 inline-block rounded px-1 py-px font-mono text-[9px] font-bold tracking-[0.1em] ${KIND_BADGE[group.kind]}`}
        >
          {KIND_LABEL[group.kind]}
        </span>
        <span className="break-words text-xs font-semibold text-ink-dim">{group.label}</span>
      </div>
      <div className="min-w-0 flex-1 py-1">
        {group.rows.map((row, i) => (
          <div key={i} className="relative h-7">
            {row.map((span) => (
              <SpanBar
                key={span.id}
                span={span}
                windowStartMs={windowStartMs}
                windowEndMs={windowEndMs}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Chronicle() {
  const [window, setWindow] = useState<WindowValue>("24");
  const { chronicle, loading, error } = useChronicle(Number(window));

  const windowStartMs = useMemo(
    () => new Date(chronicle.windowStart).getTime(),
    [chronicle.windowStart],
  );
  const windowEndMs = useMemo(() => new Date(chronicle.windowEnd).getTime(), [chronicle.windowEnd]);
  const ticks = useMemo(() => axisTicks(windowStartMs, windowEndMs), [windowStartMs, windowEndMs]);
  const hasData = chronicle.groups.length > 0 && Number.isFinite(windowStartMs);

  return (
    <Page
      title="Chronicle"
      wide
      actions={
        <SegmentedControl
          label="Time window"
          segments={[...WINDOWS]}
          value={window}
          onChange={setWindow}
        />
      }
    >
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <HealthCounter label="Spans" value={chronicle.totals.spans} />
        <HealthCounter label="In flight" value={chronicle.totals.active} tone="live" />
        <HealthCounter label="Failed" value={chronicle.totals.failed} tone="fail" />
        <HealthCounter
          label="Run spend"
          value={chronicle.totals.costUsd != null ? formatUsd(chronicle.totals.costUsd) : "—"}
        />
      </section>

      {error && (
        <div className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail">
          Couldn't reach the Argus server: {error}
        </div>
      )}

      {loading && !hasData ? (
        <p className="text-ink-faint">Loading the chronicle…</p>
      ) : !hasData ? (
        <EmptyState>
          Nothing happened in this window. Widen it, or launch an agent and watch it appear.
        </EmptyState>
      ) : (
        <div className="rounded-panel border border-line bg-surface px-4 pb-3 pt-2">
          {/* Axis */}
          <div className="flex" aria-hidden>
            <div className="w-44 shrink-0" />
            <div className="relative h-6 min-w-0 flex-1">
              {ticks.map((t) => (
                <span
                  key={t.pct}
                  className="absolute top-1 -translate-x-1/2 font-mono text-[10px] text-ink-faint"
                  style={{ left: `${t.pct}%` }}
                >
                  {t.label}
                </span>
              ))}
              <span className="absolute right-0 top-1 font-mono text-[10px] font-bold text-eye">
                now
              </span>
            </div>
          </div>

          {/* Lanes with tick gridlines behind them */}
          <div className="relative">
            <div className="pointer-events-none absolute inset-0 flex" aria-hidden>
              <div className="w-44 shrink-0" />
              <div className="relative min-w-0 flex-1">
                {ticks.map(
                  (t) =>
                    t.pct > 0 && (
                      <span
                        key={t.pct}
                        className="absolute inset-y-0 w-px bg-line/60"
                        style={{ left: `${t.pct}%` }}
                      />
                    ),
                )}
                <span className="absolute inset-y-0 right-0 w-px bg-eye/50" />
              </div>
            </div>
            {chronicle.groups.map((g) => (
              <GroupLanes
                key={g.key}
                group={g}
                windowStartMs={windowStartMs}
                windowEndMs={windowEndMs}
              />
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}
