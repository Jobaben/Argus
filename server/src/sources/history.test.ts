import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readActivity } from "./history.js";
import { invalidateCaches } from "./cache.js";

let homes: string[];
let previousHome: string | undefined;

async function fixture(raw: string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "argus-history-"));
  homes.push(home);
  await writeFile(path.join(home, "history.jsonl"), raw);
  process.env.ARGUS_CLAUDE_HOME = home;
  return home;
}

beforeEach(() => {
  homes = [];
  previousHome = process.env.ARGUS_CLAUDE_HOME;
  invalidateCaches();
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.ARGUS_CLAUDE_HOME;
  else process.env.ARGUS_CLAUDE_HOME = previousHome;
  invalidateCaches();
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

for (const [name, malformed] of [
  ["null", "null"],
  ["primitive", '"prompt"'],
  ["array", '[{"display":"bad"}]'],
  ["nonstring display", '{"display":42}'],
  ["nonstring project", '{"display":"bad","project":42}'],
  ["out-of-range timestamp", '{"display":"bad","timestamp":8640000000000001}'],
  ["infinite timestamp", '{"display":"bad","timestamp":1e999}'],
] as const) {
  test(`skips ${name} records while preserving valid recent activity`, async () => {
    await fixture('{"display":"older"}\n' + malformed + '\n{"display":"latest"}\n');
    assert.deepEqual(
      (await readActivity(1)).map((activity) => activity.text),
      ["latest"],
    );
    assert.deepEqual(
      (await readActivity()).map((activity) => activity.text),
      ["latest", "older"],
    );
  });
}

test("home changes do not reuse another home's cached activity", async () => {
  const firstHome = await fixture('{"display":"first"}\n');
  assert.equal((await readActivity())[0].text, "first");
  await fixture('{"display":"second"}\n');
  assert.equal((await readActivity())[0].text, "second");
  process.env.ARGUS_CLAUDE_HOME = firstHome;
  assert.equal((await readActivity())[0].text, "first");
});

test("normalizes valid records and keeps newest-first limit semantics", async () => {
  await fixture(
    [
      '{"display":"older"}',
      "{broken",
      '{"display":"   "}',
      '{"display":" newest ","timestamp":0,"project":" C:\\\\GIT\\\\Argus "}',
    ].join("\n"),
  );
  assert.deepEqual(await readActivity(1), [
    {
      ts: "1970-01-01T00:00:00.000Z",
      text: "newest",
      project: "Argus",
      cwd: "C:\\GIT\\Argus",
    },
  ]);
  assert.deepEqual(await readActivity(0), []);
});

test("bounded tail drops a partial oversized record and preserves its complete successor", async () => {
  await fixture(JSON.stringify({ display: "x".repeat(300_000) }) + '\n{"display":"latest"}\n');
  assert.deepEqual(
    (await readActivity()).map((activity) => activity.text),
    ["latest"],
  );
});

test("missing history returns no activity", async () => {
  const home = await fixture("");
  await rm(path.join(home, "history.jsonl"));
  assert.deepEqual(await readActivity(), []);
});
