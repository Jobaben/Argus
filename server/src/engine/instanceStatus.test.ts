/**
 * Instance status is asked through `sources/instanceStatus.ts`, never spelled
 * inline (WS14).
 *
 * Since a gate pauses only its own phase, "is this instance still going?" has
 * two answers (`running`, `awaiting-approval`) and every path that spelled it
 * by hand was fixed one at a time. Worse, four transitions *wrote* `running`
 * and hid a sibling's waiting gate. Checked from the source, as
 * `boundaries.test.ts` checks the module rules, over the engine, the
 * transitions and every server module that reads instances (the sources, the
 * CLI, the federation summary, the scheduler, the routes, the verdict watcher):
 *
 * 1. None compares an instance's status with `running` or
 *    `awaiting-approval`: use `resumable`, `appliesResults`, `inFlight` or
 *    `hasWaitingGate`.
 * 2. None spells "terminal" as the three statuses: use `isTerminal`.
 * 3. No transition or engine module assigns `running` or `awaiting-approval`
 *    to an instance: the status of a live instance is `liveStatus(inst)`.
 *
 * Comparisons with one terminal outcome (`=== "failed"` before `onFailure`)
 * ask which way the instance ended, not whether it did, and are not flagged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

/** Names an instance goes by in the scanned modules. A run is `r` or `run`. */
const INSTANCE = String.raw`\b(?:i|inst|instance|latest|fresh|current|candidate|res\.instance|done\.instance)`;
const LIVE_READ = new RegExp(
  String.raw`${INSTANCE}\.status\s*[!=]==\s*"(?:running|awaiting-approval)"`,
);
const LIVE_WRITE = new RegExp(
  String.raw`${INSTANCE}\.status\s*=\s*"(?:running|awaiting-approval)"`,
);
const TERMINAL_SPELLED = new RegExp(
  String.raw`${INSTANCE}\.status\s*[!=]==\s*"(?:succeeded|failed|aborted)"` +
    String.raw`[^;]*\.status\s*[!=]==\s*"(?:succeeded|failed|aborted)"` +
    String.raw`[^;]*\.status\s*[!=]==\s*"(?:succeeded|failed|aborted)"`,
);

/**
 * Deliberate raw reads: file, the trimmed line, and why. Keyed on the line's
 * text rather than its number, so an unrelated edit above it does not break
 * the allowlist and an edit *to* it does.
 */
const ALLOWED: Array<{ file: string; line: string; reason: string }> = [
  {
    file: "engine/reconcile.ts",
    line: `if (candidate.status === "running") continue;`,
    reason:
      "the decided-run sweep covers every instance not plainly running, a gate-waiting one included",
  },
  {
    file: "engine/reconcile.ts",
    line: `if (inst && inst.status !== "running") await sweepDecidedRuns(inst);`,
    reason: "the same sweep, re-read under the lock",
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(f));
    else if (f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts")) out.push(f);
  }
  return out;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

const scanned = [
  ...sourceFiles(path.join(SRC, "engine")),
  ...sourceFiles(path.join(SRC, "sources")),
  ...sourceFiles(path.join(SRC, "cli")),
  ...sourceFiles(path.join(SRC, "federation")),
  ...["pipelineTransitions.ts", "scheduler.ts", "app.ts", "verdictWatcher.ts"].map((f) =>
    path.join(SRC, f),
  ),
];

function offenders(pattern: RegExp, allowed: typeof ALLOWED = []): string[] {
  const out: string[] = [];
  for (const file of scanned) {
    const r = rel(file);
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((text, i) => {
        if (!pattern.test(text)) return;
        if (allowed.some((a) => a.file === r && a.line === text.trim())) return;
        out.push(`${r}:${i + 1}: ${text.trim()}`);
      });
  }
  return out;
}

test("the patterns catch what they are meant to", () => {
  assert.ok(LIVE_READ.test(`if (fresh.status !== "running") return;`), "a live read");
  assert.ok(LIVE_READ.test(`res.instance.status === "awaiting-approval"`), "a gate read");
  assert.ok(!LIVE_READ.test(`if (phase.status === "running") continue;`), "a phase read");
  assert.ok(LIVE_READ.test(`instances.filter((i) => i.status === "running")`), "a summary count");
  assert.ok(!LIVE_READ.test(`runs.filter((r) => r.status === "running")`), "a run read");
  assert.ok(LIVE_WRITE.test(`  inst.status = "running";`), "a live write");
  assert.ok(!LIVE_WRITE.test(`  phase.status = "running";`), "a phase write");
  assert.ok(
    TERMINAL_SPELLED.test(
      `if (inst.status === "succeeded" || inst.status === "failed" || inst.status === "aborted") {`,
    ),
    "terminal spelled out",
  );
  assert.ok(
    !TERMINAL_SPELLED.test(
      `if (res.instance.status === "succeeded" || res.instance.status === "failed") {`,
    ),
    "an ended-instance journal check",
  );
});

test("no raw running / awaiting-approval reads of an instance's status", () => {
  assert.deepEqual(
    offenders(LIVE_READ, ALLOWED),
    [],
    "use resumable, appliesResults or hasWaitingGate",
  );
});

test("no spelled-out terminal check of an instance's status", () => {
  assert.deepEqual(offenders(TERMINAL_SPELLED), [], "use isTerminal");
});

test("no transition or engine module writes a live instance status by hand", () => {
  assert.deepEqual(offenders(LIVE_WRITE), [], "derive it with liveStatus(inst)");
});

test("every allowlisted line still exists", () => {
  for (const a of ALLOWED) {
    const lines = readFileSync(path.join(SRC, a.file), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    assert.ok(lines.includes(a.line), `${a.file} no longer has: ${a.line}`);
  }
});
