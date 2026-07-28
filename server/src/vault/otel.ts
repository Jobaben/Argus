import { createHash } from "node:crypto";
import type { VaultRunRow } from "./query.js";

/**
 * OTLP/JSON export of the Vault's runs.
 *
 * Argus is not an observability platform and should not try to become one. What
 * it can do is hand its history to the one you already run, in the format that
 * every collector already speaks — so a run, its phases, its cost and its
 * outcome land next to the rest of your traces instead of in a tool that only
 * knows about itself.
 *
 * Written by hand rather than through the OpenTelemetry SDK on purpose: the SDK
 * is built for live instrumentation of a running process, and this is a batch
 * export of records that finished weeks ago. Pulling in a tracer, a provider
 * and an exporter to serialize a JSON document Argus already holds in memory
 * would add a dependency tree and a background pipeline to do less.
 *
 * Everything here is pure. The ids are derived, not generated, so exporting the
 * same window twice produces byte-identical spans and a collector that receives
 * both deduplicates instead of double-counting.
 */

/** OTLP requires 32 hex chars for a trace id and 16 for a span id. */
function hex(input: string, chars: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, chars);
}

export const traceIdFor = (seed: string): string => hex(`trace:${seed}`, 32);
export const spanIdFor = (seed: string): string => hex(`span:${seed}`, 16);

const nanos = (msValue: number): string => `${Math.round(msValue)}000000`;

type AttrValue = string | number | boolean | null | undefined;

function attrs(pairs: Record<string, AttrValue>) {
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const [key, v] of Object.entries(pairs)) {
    if (v == null) continue;
    if (typeof v === "number") {
      out.push({
        key,
        value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
      });
    } else if (typeof v === "boolean") {
      out.push({ key, value: { boolValue: v } });
    } else {
      out.push({ key, value: { stringValue: v } });
    }
  }
  return out;
}

/** OTLP status codes: 0 unset, 1 ok, 2 error. */
function statusOf(run: VaultRunRow): { code: number; message?: string } {
  if (run.status === "failed" || run.outcome === "failed" || run.outcome === "blocked") {
    return { code: 2, message: run.error ?? run.outcome ?? "failed" };
  }
  if (run.status === "succeeded") return { code: 1 };
  // Skipped, cancelled, interrupted and still-running are genuinely neither:
  // reporting them as ok would inflate every success rate downstream.
  return { code: 0 };
}

export interface OtelExport {
  resourceSpans: unknown[];
  /** How many spans the document carries; surfaced for the route's summary. */
  spans: number;
}

/**
 * Build an OTLP/JSON document for a set of runs.
 *
 * Pipeline phase runs share their instance's trace id, so a pipeline arrives as
 * one trace with a span per phase rather than as a scatter of unrelated roots.
 * A schedule run is its own trace, which is what it is.
 */
export function buildOtelExport(runs: VaultRunRow[], serviceName = "argus"): OtelExport {
  const spans = runs
    .filter((r) => Number.isFinite(r.atMs))
    .map((run) => {
      // `atMs` is when the run *ended*; the span must start at its start.
      const duration = run.durationMs ?? 0;
      const endMs = run.atMs;
      const startMs = endMs - duration;
      const trace = traceIdFor(run.instanceId ?? run.id);
      const status = statusOf(run);
      return {
        traceId: trace,
        spanId: spanIdFor(run.id),
        name: run.phaseId ? `${run.scheduleName} · ${run.phaseId}` : run.scheduleName || run.id,
        kind: 3, // SPAN_KIND_CLIENT: Argus is calling out to the Claude CLI.
        startTimeUnixNano: nanos(startMs),
        endTimeUnixNano: nanos(endMs),
        attributes: attrs({
          "argus.run.id": run.id,
          "argus.schedule.id": run.scheduleId,
          "argus.schedule.name": run.scheduleName,
          "argus.instance.id": run.instanceId,
          "argus.phase.id": run.phaseId,
          "argus.project": run.project,
          "argus.run.status": run.status,
          "argus.run.outcome": run.outcome,
          // gen_ai.* are the OpenTelemetry semantic conventions for model calls,
          // so cost and tokens land on the dashboards a collector already has
          // rather than in Argus-specific fields nothing knows how to chart.
          "gen_ai.system": "anthropic",
          "gen_ai.request.model": run.model,
          "gen_ai.usage.total_tokens": run.tokens,
          "argus.cost.usd": run.costUsd,
        }),
        status,
      };
    });

  return {
    spans: spans.length,
    resourceSpans:
      spans.length === 0
        ? []
        : [
            {
              resource: { attributes: attrs({ "service.name": serviceName }) },
              scopeSpans: [{ scope: { name: "argus.vault" }, spans }],
            },
          ],
  };
}
