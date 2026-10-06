/**
 * The engine's module boundaries (Hardening Item 1, checkpoint F).
 *
 * The engine is a set of factories over one shared context. These are the
 * rules that keep it that way, checked from the source:
 *
 * 1. An engine module reaches another module's *functions* only through
 *    `core.fns`. It may import, at runtime, only the engine's leaf modules —
 *    pure helpers and types (`types`, `prompts`, `outcome`, `spawn`,
 *    `constants`, `persistence`) — and a factory module only as a type.
 * 2. Nothing outside `engine/` imports an engine module, except the façade
 *    (`pipelineEngine.ts`) and tests: the rest of Argus sees the Engine.
 * 3. The pure layers — the transitions, the harness, the transition log and
 *    the durable primitives — never import the engine at all.
 * 4. No engine module imports the façade (that would be a cycle), and the
 *    façade defines no function but `createEngine`, which only wires.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const ENGINE = path.join(SRC, "engine");

const LEAVES = new Set(["types", "prompts", "outcome", "spawn", "constants", "persistence"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") out.push(...sourceFiles(f));
    } else if (f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts")) out.push(f);
  }
  return out;
}

/** Every import statement: whether it is type-only, and what it resolves to. */
function imports(file: string): Array<{ typeOnly: boolean; target: string; line: string }> {
  const text = readFileSync(file, "utf8");
  const out: Array<{ typeOnly: boolean; target: string; line: string }> = [];
  for (const m of text.matchAll(/^import\s+(type\s+)?[\s\S]*?\s+from\s+"([^"]+)";/gm)) {
    if (!m[2].startsWith(".")) continue;
    out.push({
      typeOnly: !!m[1],
      target: path
        .relative(SRC, path.resolve(path.dirname(file), m[2]))
        .split(path.sep)
        .join("/"),
      line: m[0].replace(/\s+/g, " "),
    });
  }
  return out;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

test("engine modules reach each other only through core.fns", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(ENGINE)) {
    for (const imp of imports(file)) {
      const m = /^engine\/(\w+)\.js$/.exec(imp.target);
      if (!m) continue;
      const mod = m[1];
      if (LEAVES.has(mod) || mod === "context") continue;
      if (!imp.typeOnly) offenders.push(`${rel(file)}: ${imp.line}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("only the façade and tests import engine modules", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const r = rel(file);
    if (r.startsWith("engine/") || r === "pipelineEngine.ts") continue;
    for (const imp of imports(file)) {
      if (imp.target.startsWith("engine/")) offenders.push(`${r}: ${imp.line}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the pure layers never import the engine", () => {
  const pure = [
    path.join(SRC, "pipelineTransitions.ts"),
    ...sourceFiles(path.join(SRC, "harness")),
    ...sourceFiles(path.join(SRC, "transitionLog")),
    ...sourceFiles(path.join(SRC, "durable")),
  ];
  const offenders: string[] = [];
  // Test support (the e2e harness builds a real engine) is not a pure layer.
  for (const file of pure.filter((f) => !/Support\.ts$/.test(f))) {
    for (const imp of imports(file)) {
      if (imp.target.startsWith("engine/") || imp.target === "pipelineEngine.js") {
        offenders.push(`${rel(file)}: ${imp.line}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("no engine module imports the façade, and the façade only wires", () => {
  for (const file of sourceFiles(ENGINE)) {
    for (const imp of imports(file)) {
      assert.notEqual(imp.target, "pipelineEngine.js", `${rel(file)} imports the façade`);
    }
  }
  const facade = readFileSync(path.join(SRC, "pipelineEngine.ts"), "utf8");
  const functions = [...facade.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(functions, ["createEngine"]);
  const body = facade.slice(facade.indexOf("export function createEngine"));
  assert.ok(body.split("\n").length < 60, "createEngine stays a wiring function");
});

test("every engine factory is wired into the engine exactly once", () => {
  const facade = readFileSync(path.join(SRC, "pipelineEngine.ts"), "utf8");
  const factories = sourceFiles(ENGINE).flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/^export function (create\w+)\(core: EngineCore\)/gm)].map(
      (m) => m[1],
    ),
  );
  assert.ok(factories.length >= 10);
  for (const name of factories) {
    assert.equal(
      facade.split(`Object.assign(fns, ${name}(core));`).length - 1,
      1,
      `${name} is wired once`,
    );
  }
});
