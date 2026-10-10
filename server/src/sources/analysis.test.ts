import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAnalysisRunner,
  extractJsonObject,
  type AnalysisSpawn,
  type AnalysisSpawnHandle,
  NOT_EXITED_ERROR,
  OUTPUT_CAP_ERROR,
} from "./analysis.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-analysis-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_ANALYSIS;
});

const NOW = new Date("2026-07-20T12:00:00.000Z");

/** Wraps a result string the way `claude -p --output-format json` would. */
function envelope(result: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    result,
    total_cost_usd: 0.002,
    usage: { input_tokens: 900, output_tokens: 100 },
    ...over,
  });
}

/** A spawn that resolves immediately with the given stdout. */
const respond =
  (stdout: string): AnalysisSpawn =>
  () => ({ kill: () => {}, done: Promise.resolve({ code: 0, stdout, error: null }) });

/** A spawn that never resolves until killed — for timeout tests. */
function hangingSpawn(): { spawn: AnalysisSpawn; killed: () => number } {
  let kills = 0;
  const spawn: AnalysisSpawn = () => {
    let resolve!: (v: { code: number | null; stdout: string; error: string | null }) => void;
    const done = new Promise<{ code: number | null; stdout: string; error: string | null }>(
      (r) => (resolve = r),
    );
    const handle: AnalysisSpawnHandle = {
      kill: () => {
        kills++;
        resolve({ code: null, stdout: "", error: null });
      },
      done,
    };
    return handle;
  };
  return { spawn, killed: () => kills };
}

const base = { kind: "autopsy" as const, prompt: "why?", cwd: "/tmp" };
const parseOk = (v: unknown) => (v && typeof v === "object" ? (v as { a?: number }) : null);

test("guarded dispatch rechecks after budget await and admission microtasks", async () => {
  for (const window of ["budget", "microtask"]) {
    let current = true;
    let spawned = 0;
    const runner = createAnalysisRunner({
      enabled: () => true,
      blocked: async () => {
        if (window === "budget") current = false;
        return false;
      },
      spawn: () => {
        spawned++;
        return respond(envelope('{"a":1}'))({} as never);
      },
      meter: async () => {},
    });
    const result = await runner.runWithAdmission!(base, parseOk, async () => {
      if (window === "microtask")
        queueMicrotask(() => {
          current = false;
        });
      return {
        ok: true,
        validateNow: () => (current ? { ok: true } : { ok: false, detail: "stale" }),
      };
    });
    assert.equal(spawned, 0);
    assert.equal(result.failure, "dispatch-refused");
    assert.equal(result.executionDisposition, "not-called");
    assert.equal(result.costUsd, null);
    assert.equal(result.tokens, null);
    assert.equal(runner.inFlight(), 0);
  }
});

test("guarded dispatch refuses malformed, throwing, denied and async checks without spawning", async () => {
  const admissions: unknown[] = [
    async () => ({ ok: false, detail: "denied" }),
    async () => {
      throw new Error("admission failed");
    },
    async () => null,
    async () => ({ ok: true }),
    async () => ({
      ok: true,
      validateNow: () => {
        throw new Error("final failed");
      },
    }),
    async () => ({ ok: true, validateNow: async () => ({ ok: true }) }),
    async () => ({
      ok: true,
      validateNow: async () => {
        throw new Error("async final failed");
      },
    }),
    async () => ({ ok: true, validateNow: () => ({ ok: 1 }) }),
  ];
  let spawned = 0;
  const runner = createAnalysisRunner({
    enabled: () => true,
    blocked: async () => false,
    spawn: () => {
      spawned++;
      return respond(envelope('{"a":1}'))({} as never);
    },
    meter: async () => {},
  });
  for (const admission of admissions) {
    const result = await runner.runWithAdmission!(base, parseOk, admission as never);
    assert.equal(result.failure, "dispatch-refused");
    assert.equal(result.executionDisposition, "not-called");
    assert.equal(runner.inFlight(), 0);
  }
  assert.equal(spawned, 0);
  const result = await runner.runWithAdmission!(base, parseOk, async () => ({
    ok: true,
    validateNow: () => ({ ok: true }),
  }));
  assert.equal(spawned, 1);
  assert.equal(result.ok, true);
  assert.equal(result.executionDisposition, "possibly-called");
});

test("a well-formed pass returns the parsed value with its cost and tokens", async () => {
  const runner = createAnalysisRunner({
    spawn: respond(envelope('{"a":1}')),
    now: () => NOW,
    meter: async () => {},
  });
  const res = await runner.run(base, parseOk);
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { a: 1 });
  assert.equal(res.costUsd, 0.002);
  assert.equal(res.tokens, 1000);
  assert.equal(res.failure, null);
  assert.equal(res.executionDisposition, "possibly-called");
});

test("JSON wrapped in prose and fences is still recovered", async () => {
  const runner = createAnalysisRunner({
    spawn: respond(
      envelope('Sure! Here is the analysis:\n```json\n{"a":2}\n```\nHope that helps.'),
    ),
    now: () => NOW,
    meter: async () => {},
  });
  const res = await runner.run(base, parseOk);
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { a: 2 });
});

test("regression: JSON in the right syntax but the wrong shape is a clean unparseable", async () => {
  const runner = createAnalysisRunner({
    spawn: respond(envelope('{"totally":"different"}')),
    now: () => NOW,
    meter: async () => {},
  });
  const res = await runner.run(base, () => null);
  assert.equal(res.ok, false);
  assert.equal(res.failure, "unparseable");
  assert.match(res.error ?? "", /wrong shape/);
  // The raw answer survives, so a UI can show what the model actually said.
  assert.equal(res.raw, '{"totally":"different"}');
});

test("no JSON at all is unparseable, not a throw", async () => {
  const runner = createAnalysisRunner({
    spawn: respond(envelope("I'm afraid I can't help with that.")),
    now: () => NOW,
    meter: async () => {},
  });
  const res = await runner.run(base, parseOk);
  assert.equal(res.failure, "unparseable");
});

test("an empty result is reported as no-output rather than parsed as nothing", async () => {
  const runner = createAnalysisRunner({
    spawn: respond(envelope("   ")),
    now: () => NOW,
    meter: async () => {},
  });
  const res = await runner.run(base, parseOk);
  assert.equal(res.failure, "no-output");
});

test("a pass that overruns its timeout is killed and reported", async () => {
  const { spawn, killed } = hangingSpawn();
  const runner = createAnalysisRunner({ spawn, now: () => NOW, meter: async () => {} });
  const res = await runner.run({ ...base, timeoutMs: 1000 }, parseOk);
  assert.equal(res.failure, "timeout");
  assert.equal(res.executionDisposition, "possibly-called");
  assert.equal(killed(), 1, "the process was killed, not merely abandoned");
});

test("a timed-out pass whose tree could not be confirmed dead says so, and frees the runner", async () => {
  // What spawnAnalysisProcess reports when the tree still held its pipes after
  // the whole kill ladder: released, not confirmed exited.
  const spawn: AnalysisSpawn = () => {
    let resolve!: (v: { code: number | null; stdout: string; error: string | null }) => void;
    const done = new Promise<{ code: number | null; stdout: string; error: string | null }>(
      (r) => (resolve = r),
    );
    return {
      kill: () => resolve({ code: null, stdout: "", error: NOT_EXITED_ERROR }),
      done,
    };
  };
  const runner = createAnalysisRunner({ spawn, now: () => NOW, meter: async () => {} });
  const res = await runner.run({ ...base, timeoutMs: 1000 }, parseOk);
  assert.equal(res.failure, "timeout");
  assert.equal(res.error, `timed out after 1000ms; ${NOT_EXITED_ERROR}`);
  assert.equal(runner.inFlight(), 0);

  const clean = createAnalysisRunner({
    spawn: hangingSpawn().spawn,
    now: () => NOW,
    meter: async () => {},
  });
  const ok = await clean.run({ ...base, timeoutMs: 1000 }, parseOk);
  assert.equal(ok.error, "timed out after 1000ms", "a confirmed kill reads as before");
});

test("an output-cap failure keeps its class, and says so when the killed tree was not confirmed to exit", async () => {
  // What spawnAnalysisProcess reports for each case: a cap whose tree then
  // exited, and a cap whose tree still held its pipes after the kill ladder.
  const capped =
    (error: string): AnalysisSpawn =>
    () => ({ kill: () => {}, done: Promise.resolve({ code: null, stdout: "", error }) });

  const exited = await createAnalysisRunner({
    spawn: capped(OUTPUT_CAP_ERROR),
    now: () => NOW,
    meter: async () => {},
  }).run(base, parseOk);
  assert.equal(exited.ok, false);
  assert.equal(exited.failure, "output-cap");
  assert.equal(exited.error, OUTPUT_CAP_ERROR);

  const runner = createAnalysisRunner({
    spawn: capped(`${OUTPUT_CAP_ERROR}; ${NOT_EXITED_ERROR}`),
    now: () => NOW,
    meter: async () => {},
  });
  const unconfirmed = await runner.run(base, parseOk);
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.failure, "output-cap", "still classified by its cause");
  assert.equal(unconfirmed.error, `${OUTPUT_CAP_ERROR}; ${NOT_EXITED_ERROR}`);
  assert.equal(runner.inFlight(), 0);
});

test("regression: a pass that cost money is metered even when it failed", async () => {
  const metered: (number | null)[] = [];
  const runner = createAnalysisRunner({
    spawn: respond(envelope("no json here")),
    now: () => NOW,
    meter: async (usd) => {
      metered.push(usd);
    },
  });
  const res = await runner.run(base, parseOk);
  assert.equal(res.ok, false);
  assert.deepEqual(metered, [0.002], "a ledger that only counts successes understates spend");
});

test("a metering failure does not fail the pass", async () => {
  const runner = createAnalysisRunner({
    spawn: respond(envelope('{"a":3}')),
    now: () => NOW,
    meter: async () => {
      throw new Error("ledger on fire");
    },
  });
  const res = await runner.run(base, parseOk);
  assert.equal(res.ok, true);
});

test("passes are serialized: a second while one is in flight is refused, not queued", async () => {
  const { spawn } = hangingSpawn();
  let dispatched = 0;
  const runner = createAnalysisRunner({
    spawn: (opts) => {
      dispatched++;
      return spawn(opts);
    },
    now: () => NOW,
    meter: async () => {},
  });
  const first = runner.run({ ...base, timeoutMs: 1000 }, parseOk);
  const second = await runner.run(base, parseOk);
  assert.equal(second.failure, "busy");
  assert.equal(second.executionDisposition, "not-called");
  assert.equal(runner.inFlight(), 1);
  await first;
  assert.equal(dispatched, 1);
  assert.equal(runner.inFlight(), 0);
});

test("the budget hard stop refuses a pass before it spawns", async () => {
  let spawned = 0;
  const runner = createAnalysisRunner({
    spawn: () => {
      spawned++;
      return respond(envelope('{"a":1}'))({
        prompt: "",
        cwd: "",
        model: "",
        runtime: "claude",
        maxOutputBytes: 0,
      });
    },
    now: () => NOW,
    blocked: async () => true,
    meter: async () => {},
  });
  const res = await runner.run(base, parseOk);
  assert.equal(res.failure, "budget-blocked");
  assert.equal(res.executionDisposition, "not-called");
  assert.equal(spawned, 0, "Argus explaining the overspend must not be part of the overspend");
});

test("ARGUS_ANALYSIS=off disables every pass without spawning", async () => {
  let spawned = 0;
  const runner = createAnalysisRunner({
    spawn: () => {
      spawned++;
      throw new Error("should not spawn");
    },
    now: () => NOW,
    meter: async () => {},
    enabled: () => false,
  });
  const res = await runner.run(base, parseOk);
  assert.equal(res.failure, "disabled");
  assert.equal(res.executionDisposition, "not-called");
  assert.equal(spawned, 0);
});

test("a spawn error is reported rather than thrown", async () => {
  const runner = createAnalysisRunner({
    spawn: () => ({
      kill: () => {},
      done: Promise.resolve({ code: null, stdout: "", error: "spawn claude ENOENT" }),
    }),
    now: () => NOW,
    meter: async () => {},
  });
  const res = await runner.run(base, parseOk);
  assert.equal(res.failure, "spawn-failed");
  assert.equal(res.executionDisposition, "possibly-called");
  assert.match(res.error ?? "", /ENOENT/);
});

test("the concurrency slot is released even when the spawn throws", async () => {
  const runner = createAnalysisRunner({
    spawn: () => {
      throw new Error("boom");
    },
    now: () => NOW,
    meter: async () => {},
  });
  await assert.rejects(() => runner.run(base, parseOk));
  assert.equal(runner.inFlight(), 0, "a thrown spawn must not wedge the runner forever");
});

test("extractJsonObject handles braces inside strings and trailing noise", () => {
  assert.deepEqual(extractJsonObject('prefix {"a":"has } brace"} suffix }'), {
    a: "has } brace",
  });
  assert.equal(extractJsonObject("no object here"), undefined);
  assert.equal(extractJsonObject("{ unbalanced"), undefined);
  assert.equal(extractJsonObject("{not: json}"), undefined);
});

test("analysis rejection preserves distinct process and runtime failure provenance", async () => {
  for (const [code, isError, failure, error] of [
    [1, false, "nonzero-exit", "the process exited with code 1"],
    [null, false, "exit-code-unavailable", "the process ended without an exit code"],
    [0, true, "runtime-failed", "the runtime reported a failed inference"],
  ] as const) {
    let parsed = 0;
    let metered = 0;
    const runner = createAnalysisRunner({
      spawn: () => ({
        kill() {},
        done: Promise.resolve({
          code,
          stdout: envelope('{"a":1}', { is_error: isError }),
          error: null,
        }),
      }),
      now: () => NOW,
      blocked: async () => false,
      meter: async () => {
        metered++;
      },
    });
    const result = await runner.run(base, () => {
      parsed++;
      return { a: 1 };
    });
    assert.equal(result.ok, false);
    assert.equal(result.value, null);
    assert.equal(result.failure, failure);
    assert.equal(result.executionDisposition, "possibly-called");
    assert.equal(result.error, error);
    assert.equal(result.raw, '{"a":1}');
    assert.equal(parsed, 0);
    assert.equal(metered, 1);
    assert.equal(result.costUsd, 0.002);
  }
});

test("invalid reported monetary scalars remain unknown before analysis metering", async () => {
  for (const cost of [-0.2, "", false, [], "0.2"]) {
    const metered: Array<number | null> = [];
    const runner = createAnalysisRunner({
      spawn: respond(envelope('{"a":1}', { total_cost_usd: cost })),
      now: () => NOW,
      blocked: async () => false,
      meter: async (value) => {
        metered.push(value);
      },
    });
    const result = await runner.run(base, parseOk);
    assert.equal(result.ok, true);
    assert.equal(result.costUsd, null);
    assert.deepEqual(metered, [null]);
  }
});
