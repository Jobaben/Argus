import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveName, normalizeAgentStatus } from "./jobs.js";

describe("normalizeAgentStatus", () => {
  it("passes through every status the contract promises", () => {
    for (const s of ["working", "done", "failed", "idle", "queued", "stopped", "unknown"]) {
      assert.equal(normalizeAgentStatus(s), s);
    }
  });

  it("maps a state Claude Code invented in a newer CLI to unknown", () => {
    // The whole point: Argus does not own this string, so an unrecognised value
    // must not leak into a client union and fall through every switch arm.
    assert.equal(normalizeAgentStatus("hibernating"), "unknown");
    assert.equal(normalizeAgentStatus("WORKING"), "unknown");
  });

  it("maps a missing or non-string state to unknown", () => {
    assert.equal(normalizeAgentStatus(undefined), "unknown");
    assert.equal(normalizeAgentStatus(null), "unknown");
    assert.equal(normalizeAgentStatus(7), "unknown");
    assert.equal(normalizeAgentStatus({}), "unknown");
  });
});

describe("deriveName", () => {
  it("keeps a name the human set with --name", () => {
    assert.equal(
      deriveName({ name: "tyre-matching", nameSource: "user", cwd: "/home/u/Spectacle" }, "9f2a"),
      "tyre-matching",
    );
  });

  it("keeps a human-set name that Claude Code suffixed to dodge a collision", () => {
    assert.equal(
      deriveName({ name: "review (2)", nameSource: "collision", cwd: "/home/u/Spectacle" }, "9f2a"),
      "review (2)",
    );
  });

  it("prefers the cwd segment over a label Claude Code derived from the prompt", () => {
    assert.equal(
      deriveName(
        { name: "fix the failing booking test", nameSource: "auto", cwd: "/home/u/Spectacle" },
        "9f2a",
      ),
      "Spectacle",
    );
  });

  it("falls back to the derived label when there is no cwd to prefer", () => {
    assert.equal(
      deriveName({ name: "fix the failing booking test", nameSource: "auto" }, "9f2a"),
      "fix the failing booking test",
    );
  });

  it("keeps the name when nameSource is absent", () => {
    // Every job written before the field existed, and every CLI that never
    // emits it — demoting these would silently discard names set with --name.
    assert.equal(
      deriveName({ name: "tyre-matching", cwd: "/home/u/Spectacle" }, "9f2a"),
      "tyre-matching",
    );
  });

  it("keeps the name when nameSource is a value this build has never heard of", () => {
    assert.equal(
      deriveName(
        { name: "tyre-matching", nameSource: "derived", cwd: "/home/u/Spectacle" },
        "9f2a",
      ),
      "tyre-matching",
    );
  });

  it("ignores a blank derived name and still prefers the cwd segment", () => {
    assert.equal(
      deriveName({ name: "   ", nameSource: "auto", cwd: "C:\\GIT\\Spectacle" }, "9f2a"),
      "Spectacle",
    );
  });

  it("falls back to the short id when there is neither a name nor a cwd", () => {
    assert.equal(deriveName({}, "9f2a"), "9f2a");
    assert.equal(deriveName({ name: "   ", nameSource: "auto" }, "9f2a"), "9f2a");
  });
});
