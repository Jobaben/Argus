import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentStatus } from "./jobs.js";

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
