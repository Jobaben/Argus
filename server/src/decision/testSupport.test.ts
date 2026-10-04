import { test } from "node:test";
import assert from "node:assert/strict";
import { homeSpellings, settleJournalOrder, withoutHome } from "./testSupport.js";

// The state-isolation tests compare two scenarios run in two temp homes; these
// pin what their normalization does and does not hide, on any platform.

const WIN_HOME = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\argus-h2-state-on-AbC123`;

test("a Windows home is recognised raw, with forward slashes and JSON-escaped", () => {
  const spellings = homeSpellings(WIN_HOME);
  assert.ok(spellings.includes(WIN_HOME));
  assert.ok(spellings.includes("C:/Users/RUNNER~1/AppData/Local/Temp/argus-h2-state-on-AbC123"));
  assert.ok(spellings.includes(JSON.stringify(WIN_HOME).slice(1, -1)));

  const persisted = JSON.stringify({
    artifactDir: `${WIN_HOME}-argus\\artifacts\\i1\\publish`,
    rule: `Edit(//C:/Users/RUNNER~1/AppData/Local/Temp/argus-h2-state-on-AbC123/x/**)`,
  });
  assert.equal(
    withoutHome(persisted, WIN_HOME),
    JSON.stringify({
      artifactDir: "<HOME>-argus\\artifacts\\i1\\publish",
      rule: "Edit(//<HOME>/x/**)",
    }),
  );
});

test("a POSIX home is the one spelling, and replacement is unchanged there", () => {
  assert.deepEqual(homeSpellings("/tmp/argus-h1-state-off-Xy9"), ["/tmp/argus-h1-state-off-Xy9"]);
  assert.equal(
    withoutHome('{"cwd":"/tmp/argus-h1-state-off-Xy9/w"}', "/tmp/argus-h1-state-off-Xy9"),
    '{"cwd":"<HOME>/w"}',
  );
});

test("only the home itself is hidden: anything that differs below it still differs", () => {
  const on = withoutHome(`${WIN_HOME}\\argus\\runs\\r1.json`, WIN_HOME);
  const off = withoutHome(`${WIN_HOME}\\argus\\runs\\r2.json`, WIN_HOME);
  assert.notEqual(on, off);
  assert.equal(withoutHome("C:\\Users\\someone-else\\x", WIN_HOME), "C:\\Users\\someone-else\\x");
});

test("journal order is settled under either path separator, and only for journals", () => {
  const text = ['{"at":"t1","k":"b"}', '{"at":"t1","k":"a"}', '{"at":"t2","k":"c"}', ""].join("\n");
  const settled = ['{"at":"t1","k":"a"}', '{"at":"t1","k":"b"}', '{"at":"t2","k":"c"}', ""].join(
    "\n",
  );
  assert.equal(settleJournalOrder("argus/journals/i1.jsonl", text), settled);
  assert.equal(settleJournalOrder("argus\\journals\\i1.jsonl", text), settled);
  assert.equal(settleJournalOrder("argus\\runs\\i1.jsonl", text), text);
});
