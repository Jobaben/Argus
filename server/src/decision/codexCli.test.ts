import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  createAnalysisRunner,
  type AnalysisRunner,
  type AnalysisSpawn,
} from "../sources/analysis.js";
import { createCodexCliProvider } from "./providers/codexCli.js";
import { harness, RESIDUAL_P, tempRoot } from "./testSupport.js";
import { RESIDUAL_CAUSE_V1 } from "./definitions.js";
import type { StoredSnapshot } from "@argus/contracts";

for (const [name, answer, expected] of [
  ["valid", { p: RESIDUAL_P }, "answered"],
  ["invalid", { p: { other: 2 } }, "failed"],
  ["abstention", { abstain: true, reason: "missing evidence" }, "abstained"],
] as const) {
  test(`Codex pinned execution and retained snapshot: ${name}`, async () => {
    const seen: Parameters<AnalysisSpawn>[0][] = [];
    const meters: unknown[] = [];
    const runner = createAnalysisRunner({
      enabled: () => true,
      blocked: async () => false,
      meter: async (c, t) => {
        meters.push([c, t]);
      },
      spawn: (o) => {
        seen.push(o);
        return {
          kill() {},
          done: Promise.resolve({
            code: 0,
            error: null,
            stdout: [
              JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: JSON.stringify(answer) },
              }),
              JSON.stringify({
                type: "turn.completed",
                usage: { input_tokens: 100, output_tokens: 20 },
              }),
            ].join("\n"),
          }),
        };
      },
    });
    const cwd = path.join(tempRoot(), "cwd");
    mkdirSync(cwd);
    const provider = createCodexCliProvider({
      runner,
      cwd,
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });
    const h = harness({ providers: { codex: provider } });
    const r = await h.service.assess({
      question: "run.failure-cause.residual",
      subject: { kind: "run", runId: "run-1" },
      provider: "codex",
    });
    assert.ok(r.ok);
    assert.equal(r.assessment.provider.provider, "codex-cli");
    assert.equal(r.assessment.provider.requestedModel, "gpt-5.6-luna");
    assert.equal(r.assessment.provider.reportedModel, null);
    assert.equal(r.assessment.outcome.status, expected);
    assert.equal(seen[0].runtime, "codex");
    assert.equal(seen[0].reasoningEffort, "low");
    assert.equal(seen[0].decisionIsolation, true);
    assert.ok(typeof r.assessment.costUsd === "number" && r.assessment.costUsd > 0);
    assert.equal(meters.length, 1);
    assert.equal((await h.journal.loadSnapshot(r.assessment.snapshot.sha256)).status, "retained");
  });
}

for (const mode of ["expired", "aborted", "unsupported-runner"] as const) {
  test(`Codex preserves guarded dispatch refusal: ${mode}`, async () => {
    let calls = 0;
    const controller = new AbortController();
    const guarded = createAnalysisRunner({
      enabled: () => true,
      blocked: async () => false,
      meter: async () => {},
      spawn: () => {
        calls++;
        throw new Error("a refused dispatch must not spawn");
      },
    });
    const runner: AnalysisRunner =
      mode === "unsupported-runner" ? { run: guarded.run, inFlight: guarded.inFlight } : guarded;
    const cwd = path.join(tempRoot(), "cwd");
    mkdirSync(cwd);
    const provider = createCodexCliProvider({ runner, cwd, model: "gpt-5.6-luna" });
    const snapshot: StoredSnapshot = {
      sha256: "0".repeat(64),
      bytes: 0,
      content: {
        format: "argus.decision-snapshot",
        formatVersion: 1,
        projection: { id: "run-failure", version: 1, digest: "0".repeat(64) },
        subject: { kind: "run", runId: "r" },
        refs: { runs: [], claims: [], verifications: [], artifacts: [] },
        subjectAuthored: [],
        redactions: [],
        truncations: [],
        body: {},
      },
    };
    const result = await provider.assessWithAdmission!(
      RESIDUAL_CAUSE_V1,
      snapshot,
      controller.signal,
      async () => ({
        ok: true,
        validateNow: () => {
          if (mode === "aborted") controller.abort();
          return mode === "expired" ? { ok: false, detail: "reservation expired" } : { ok: true };
        },
      }),
    );
    assert.equal(calls, 0);
    assert.equal(result.executionDisposition, "not-called");
    assert.equal(result.outcome.status === "failed" && result.outcome.failure, "dispatch-refused");
    assert.equal(result.identity.provider, "codex-cli");
  });
}
