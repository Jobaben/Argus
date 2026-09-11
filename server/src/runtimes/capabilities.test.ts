import { test } from "node:test";
import assert from "node:assert/strict";
import { unsupportedCapabilities } from "./types.js";
import type { CapabilityProfile } from "@argus/contracts";

test("an empty profile has no limitations, whatever the supported list is", () => {
  assert.deepEqual(unsupportedCapabilities({}, "Some Runtime", []), []);
  assert.deepEqual(unsupportedCapabilities({}, "Some Runtime", ["filesystem"]), []);
});

test("every present key not in `supported` is reported, in a fixed order", () => {
  const profile: CapabilityProfile = {
    maxTurns: 3,
    filesystem: "read-only",
    permissionMode: "plan",
    tools: { allow: ["Read"] },
    additionalDirectories: ["/a"],
    settingSources: ["project"],
    mcpServers: { docs: { command: "docs-mcp" } },
  };
  assert.deepEqual(unsupportedCapabilities(profile, "Some Runtime", []), [
    'Some Runtime cannot enforce "filesystem" for this invocation',
    'Some Runtime cannot enforce "tools" for this invocation',
    'Some Runtime cannot enforce "mcpServers" for this invocation',
    'Some Runtime cannot enforce "additionalDirectories" for this invocation',
    'Some Runtime cannot enforce "settingSources" for this invocation',
    'Some Runtime cannot enforce "permissionMode" for this invocation',
    'Some Runtime cannot enforce "maxTurns" for this invocation',
  ]);
});

test("a key present in `supported` is never reported", () => {
  const profile: CapabilityProfile = { filesystem: "read-only", maxTurns: 5 };
  assert.deepEqual(unsupportedCapabilities(profile, "Some Runtime", ["filesystem"]), [
    'Some Runtime cannot enforce "maxTurns" for this invocation',
  ]);
  assert.deepEqual(
    unsupportedCapabilities(profile, "Some Runtime", ["filesystem", "maxTurns"]),
    [],
  );
});

test("mcpServers counts as present even when it is `{}`", () => {
  assert.deepEqual(unsupportedCapabilities({ mcpServers: {} }, "Some Runtime", []), [
    'Some Runtime cannot enforce "mcpServers" for this invocation',
  ]);
});

test("`env` and `enforcement` are engine-owned and never reported, supported or not", () => {
  const profile: CapabilityProfile = {
    env: { inherit: "minimal" },
    enforcement: "best-effort",
  };
  assert.deepEqual(unsupportedCapabilities(profile, "Some Runtime", []), []);
});
