import test from "node:test";
import assert from "node:assert/strict";
import { buildOtelExport, spanIdFor, traceIdFor } from "./otel.js";
import type { VaultRunRow } from "./query.js";

function row(over: Partial<VaultRunRow> = {}): VaultRunRow {
  return {
    id: "r1",
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    instanceId: null,
    phaseId: null,
    project: "-home-u-proj",
    model: "opus",
    status: "succeeded",
    outcome: null,
    atMs: Date.parse("2026-07-20T10:05:00.000Z"),
    durationMs: 300_000,
    costUsd: 0.2,
    tokens: 3000,
    summary: "ok",
    error: null,
    ...over,
  };
}

function attrMap(span: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of span.attributes as { key: string; value: Record<string, unknown> }[]) {
    out[a.key] = Object.values(a.value)[0];
  }
  return out;
}

const spansOf = (doc: ReturnType<typeof buildOtelExport>) =>
  ((doc.resourceSpans[0] as { scopeSpans: { spans: Record<string, unknown>[] }[] } | undefined)
    ?.scopeSpans[0].spans ?? []) as Record<string, unknown>[];

test("ids are the right width and derived, not generated", () => {
  assert.equal(traceIdFor("x").length, 32);
  assert.equal(spanIdFor("x").length, 16);
  // Exporting the same window twice must produce identical documents, so a
  // collector that receives both deduplicates instead of double-counting.
  assert.equal(traceIdFor("x"), traceIdFor("x"));
  assert.notEqual(traceIdFor("x"), spanIdFor("x"));
});

test("a run becomes one span, timed from its start rather than its end", () => {
  const [span] = spansOf(buildOtelExport([row()]));
  assert.equal(span.startTimeUnixNano, `${Date.parse("2026-07-20T10:00:00.000Z")}000000`);
  assert.equal(span.endTimeUnixNano, `${Date.parse("2026-07-20T10:05:00.000Z")}000000`);
  const attrs = attrMap(span);
  assert.equal(attrs["gen_ai.request.model"], "opus");
  assert.equal(attrs["gen_ai.usage.total_tokens"], "3000");
  assert.equal(attrs["argus.cost.usd"], 0.2);
});

test("phases of one instance share a trace; separate schedules do not", () => {
  const spans = spansOf(
    buildOtelExport([
      row({ id: "a", instanceId: "inst-1", phaseId: "plan" }),
      row({ id: "b", instanceId: "inst-1", phaseId: "build" }),
      row({ id: "c" }),
    ]),
  );
  assert.equal(spans[0].traceId, spans[1].traceId);
  assert.notEqual(spans[0].spanId, spans[1].spanId);
  assert.notEqual(spans[2].traceId, spans[0].traceId);
  assert.equal(spans[1].name, "Nightly triage · build");
});

test("regression: skipped and running runs are unset, not ok", () => {
  const statuses = ["succeeded", "failed", "skipped", "running", "cancelled"].map((status) => {
    const [span] = spansOf(buildOtelExport([row({ status })]));
    return (span.status as { code: number }).code;
  });
  // Reporting a skipped run as ok inflates every success rate the collector
  // computes downstream, and the run never happened at all.
  assert.deepEqual(statuses, [1, 2, 0, 0, 0]);
});

test("a signalled failure is an error even when the process exited zero", () => {
  const [span] = spansOf(buildOtelExport([row({ status: "succeeded", outcome: "failed" })]));
  assert.equal((span.status as { code: number }).code, 2);
});

test("an empty window is an empty document, not a resource with no spans", () => {
  const doc = buildOtelExport([]);
  assert.deepEqual(doc.resourceSpans, []);
  assert.equal(doc.spans, 0);
});

test("a run with no duration is an instant, not a span reaching back to 1970", () => {
  const [span] = spansOf(buildOtelExport([row({ durationMs: null })]));
  assert.equal(span.startTimeUnixNano, span.endTimeUnixNano);
});

test("null attributes are omitted rather than exported as the string 'null'", () => {
  const [span] = spansOf(buildOtelExport([row({ model: null, costUsd: null, project: null })]));
  const attrs = attrMap(span);
  assert.equal("gen_ai.request.model" in attrs, false);
  assert.equal("argus.cost.usd" in attrs, false);
  assert.equal("argus.project" in attrs, false);
});
