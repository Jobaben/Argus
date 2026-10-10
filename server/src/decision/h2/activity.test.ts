import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnalysisDispatchAdmission, AnalysisRequest, AnalysisRunner } from "../../sources/analysis.js";
import { countAnalysisPasses } from "./activity.js";

test("counting runner preserves guarded capability, arguments, receiver and counters", async () => {
  const request: AnalysisRequest = { kind: "autopsy", prompt: "test", cwd: "/tmp" };
  const parse = (value: unknown) => value;
  const admission: AnalysisDispatchAdmission = async () => ({ ok: true, validateNow: () => ({ ok: true }) });
  let calls = 0;
  const inner: AnalysisRunner = {
    run: async () => { throw new Error("unchecked run"); },
    inFlight() { assert.equal(this, inner); return 2; },
    async runWithAdmission(req, parser, hook) {
      assert.equal(this, inner);
      assert.equal(req, request);
      assert.equal(parser, parse);
      assert.equal(hook, admission);
      assert.equal((await hook()).ok, true);
      calls++;
      return { ok: false, value: null, raw: "", costUsd: null, tokens: null, durationMs: 0, failure: "dispatch-refused", error: "test", runtime: "claude", requestedModel: null, reportedModel: null };
    },
  };
  const wrapper = countAnalysisPasses(inner);
  await wrapper.runWithAdmission!(request, parse, admission);
  assert.equal(calls, 1);
  assert.equal(wrapper.passesStarted(), 1);
  request.kind = "decide";
  await wrapper.runWithAdmission!(request, parse, admission);
  assert.equal(wrapper.passesStarted(), 1);
  assert.equal(wrapper.inFlight(), 2);
});

test("counting runner leaves missing guarded capability absent", () => {
  const inner: AnalysisRunner = { run: async () => { throw new Error("unchecked run"); }, inFlight: () => 0 };
  assert.equal(countAnalysisPasses(inner).runWithAdmission, undefined);
});
