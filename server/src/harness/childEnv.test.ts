import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChildEnv,
  matchesEnvPattern,
  MINIMAL_BASELINE,
  ARGUS_SERVER_SECRETS,
} from "./childEnv.js";

test("matchesEnvPattern: exact name match", () => {
  assert.equal(matchesEnvPattern("PATH", "PATH"), true);
  assert.equal(matchesEnvPattern("PATH", "path"), false);
  assert.equal(matchesEnvPattern("PATH2", "PATH"), false);
});

test("matchesEnvPattern: trailing-star prefix match", () => {
  assert.equal(matchesEnvPattern("CLAUDE_HOME", "CLAUDE_*"), true);
  assert.equal(matchesEnvPattern("CLAUDE_", "CLAUDE_*"), true);
  assert.equal(matchesEnvPattern("CLAUDECODE", "CLAUDE_*"), false);
  assert.equal(matchesEnvPattern("XCLAUDE_HOME", "CLAUDE_*"), false);
});

test("matchesEnvPattern: only a trailing star is a wildcard, everything else is literal", () => {
  // A `*` in the middle (or anywhere but the end) is not special.
  assert.equal(matchesEnvPattern("AWS_KEY", "AWS_*KEY"), false);
  assert.equal(matchesEnvPattern("AWS_*KEY", "AWS_*KEY"), true);
});

test("inherit all (default): ARGUS_TOKEN is stripped even though everything else passes", () => {
  const parent = { PATH: "/bin", ARGUS_TOKEN: "s3cr3t", HOME: "/home/u", GIT_AUTHOR: "me" };
  const { env, passed, stripped } = buildChildEnv(parent, undefined);
  assert.equal(env.ARGUS_TOKEN, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.GIT_AUTHOR, "me");
  assert.deepEqual(passed, ["GIT_AUTHOR", "HOME", "PATH"]);
  assert.deepEqual(stripped, ["ARGUS_TOKEN"]);
});

test("ARGUS_TOKEN is stripped even when explicitly allowed", () => {
  const parent = { PATH: "/bin", ARGUS_TOKEN: "s3cr3t" };
  const { env, stripped } = buildChildEnv(parent, { allow: ["ARGUS_TOKEN"] });
  assert.equal(env.ARGUS_TOKEN, undefined);
  assert.ok(stripped.includes("ARGUS_TOKEN"));
});

test("ARGUS_WEBHOOK_URL is also always stripped", () => {
  const parent = { PATH: "/bin", ARGUS_WEBHOOK_URL: "http://example/hook" };
  const { env } = buildChildEnv(parent, { allow: ["ARGUS_WEBHOOK_URL"], inherit: "minimal" });
  assert.equal(env.ARGUS_WEBHOOK_URL, undefined);
});

for (const name of ARGUS_SERVER_SECRETS) {
  test(`ARGUS_SERVER_SECRETS entry ${name} is never passed under any policy shape`, () => {
    const parent = { [name]: "value", PATH: "/bin" };
    const policies: (EnvPolicyLike | undefined)[] = [
      undefined,
      { inherit: "all" },
      { inherit: "minimal" },
      { inherit: "minimal", allow: [name] },
      { inherit: "all", allow: [name] },
    ];
    for (const policy of policies) {
      const { env } = buildChildEnv(parent, policy);
      assert.equal(env[name], undefined, `policy ${JSON.stringify(policy)} leaked ${name}`);
    }
  });
}

// Minimal local type alias for the loop above — keeps this file independent
// of importing EnvPolicy just for a test-only union.
type EnvPolicyLike = {
  inherit?: "all" | "minimal";
  allow?: string[];
  deny?: string[];
  set?: Record<string, string>;
};

test("inherit minimal: keeps PATH/HOME/CLAUDE_* baseline, drops unrelated secrets", () => {
  const parent = {
    PATH: "/bin",
    HOME: "/home/u",
    CLAUDE_API_KEY: "ck",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    RANDOM_VAR: "x",
  };
  const { env, passed, stripped } = buildChildEnv(parent, { inherit: "minimal" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.CLAUDE_API_KEY, "ck");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.RANDOM_VAR, undefined);
  assert.deepEqual(passed, ["CLAUDE_API_KEY", "HOME", "PATH"]);
  assert.deepEqual(stripped, ["AWS_SECRET_ACCESS_KEY", "RANDOM_VAR"]);
});

test("inherit minimal + allow pattern: AWS_* passes through", () => {
  const parent = {
    PATH: "/bin",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AWS_REGION: "us-east-1",
    OTHER: "x",
  };
  const { env, passed } = buildChildEnv(parent, { inherit: "minimal", allow: ["AWS_*"] });
  assert.equal(env.AWS_SECRET_ACCESS_KEY, "aws-secret");
  assert.equal(env.AWS_REGION, "us-east-1");
  assert.equal(env.OTHER, undefined);
  assert.deepEqual(passed, ["AWS_REGION", "AWS_SECRET_ACCESS_KEY", "PATH"]);
});

test("inherit all + deny pattern: removes matching names", () => {
  const parent = { PATH: "/bin", AWS_SECRET_ACCESS_KEY: "aws-secret", AWS_REGION: "us-east-1" };
  const { env, stripped } = buildChildEnv(parent, { deny: ["AWS_*"] });
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.AWS_REGION, undefined);
  assert.equal(env.PATH, "/bin");
  assert.deepEqual(stripped, ["AWS_REGION", "AWS_SECRET_ACCESS_KEY"]);
});

test("allow beats deny for the same variable", () => {
  const parent = { PATH: "/bin", AWS_REGION: "us-east-1" };
  const { env } = buildChildEnv(parent, { deny: ["AWS_*"], allow: ["AWS_REGION"] });
  assert.equal(env.AWS_REGION, "us-east-1");
});

test("layers are always passed regardless of policy, and later layers win", () => {
  const parent = { PATH: "/bin" };
  const { env, passed } = buildChildEnv(
    parent,
    { inherit: "minimal" },
    { CUSTOM_VAR: "first", ARGUS_RUN_ID: "run-1" },
    { CUSTOM_VAR: "second" },
  );
  assert.equal(env.CUSTOM_VAR, "second");
  assert.equal(env.ARGUS_RUN_ID, "run-1");
  assert.ok(passed.includes("CUSTOM_VAR"));
  assert.ok(passed.includes("ARGUS_RUN_ID"));
});

test("policy.set wins over layers", () => {
  const parent = {};
  const { env } = buildChildEnv(
    parent,
    { set: { CUSTOM_VAR: "from-policy" } },
    { CUSTOM_VAR: "from-layer" },
  );
  assert.equal(env.CUSTOM_VAR, "from-policy");
});

test("parent ARGUS_RUN_ID is dropped, but a layer's ARGUS_RUN_ID is kept", () => {
  const parent = { PATH: "/bin", ARGUS_RUN_ID: "stale-parent-run" };
  const { env, stripped } = buildChildEnv(parent, undefined, { ARGUS_RUN_ID: "fresh-run" });
  assert.equal(env.ARGUS_RUN_ID, "fresh-run");
  // It existed in the parent and is absent from... well it IS present in the
  // final env (via the layer), so it must not appear in `stripped`.
  assert.ok(!stripped.includes("ARGUS_RUN_ID"));
});

test("parent per-invocation identifiers are dropped when no layer supplies them", () => {
  const parent = {
    PATH: "/bin",
    ARGUS_SIGNAL_TOKEN: "old-token",
    ARGUS_SIGNAL_URL: "http://old/signal",
    ARGUS_RESULT_FILE: "/old/result.json",
    ARGUS_ARTIFACT_DIR: "/old/artifacts",
    ARGUS_INSTANCE_ID: "old-instance",
    ARGUS_PHASE_ID: "old-phase",
  };
  const { env, stripped } = buildChildEnv(parent, undefined);
  for (const name of [
    "ARGUS_SIGNAL_TOKEN",
    "ARGUS_SIGNAL_URL",
    "ARGUS_RESULT_FILE",
    "ARGUS_ARTIFACT_DIR",
    "ARGUS_INSTANCE_ID",
    "ARGUS_PHASE_ID",
  ]) {
    assert.equal(env[name], undefined, `${name} should be stripped`);
    assert.ok(stripped.includes(name), `${name} should be reported as stripped`);
  }
});

test("passed and stripped are sorted", () => {
  const parent = { ZED: "1", ALPHA: "2", MIDDLE: "3", ARGUS_TOKEN: "secret", BETA_SECRET: "4" };
  const { passed, stripped } = buildChildEnv(parent, { deny: ["BETA_SECRET"] });
  assert.deepEqual(passed, [...passed].sort());
  assert.deepEqual(stripped, [...stripped].sort());
  assert.deepEqual(passed, ["ALPHA", "MIDDLE", "ZED"]);
  assert.deepEqual(stripped, ["ARGUS_TOKEN", "BETA_SECRET"]);
});

test("undefined parent values are dropped and do not appear in passed or stripped", () => {
  const parent: NodeJS.ProcessEnv = { PATH: "/bin", GHOST: undefined };
  const { env, passed, stripped } = buildChildEnv(parent, undefined);
  assert.equal(env.PATH, "/bin");
  assert.ok(!("GHOST" in env));
  assert.ok(!passed.includes("GHOST"));
  assert.ok(!stripped.includes("GHOST"));
});

test("MINIMAL_BASELINE includes the documented agent CLI and Windows essentials", () => {
  for (const expected of [
    "PATH",
    "HOME",
    "CLAUDE_*",
    "ANTHROPIC_*",
    "CODEX_*",
    "OPENAI_*",
    "QWEN_*",
    "OPENCODE_*",
  ]) {
    assert.ok(MINIMAL_BASELINE.includes(expected), `expected ${expected} in MINIMAL_BASELINE`);
  }
  // Explicitly NOT in the baseline: authors must opt in via `allow`.
  assert.ok(!MINIMAL_BASELINE.some((p) => matchesEnvPattern("GIT_AUTHOR_NAME", p)));
  assert.ok(!MINIMAL_BASELINE.some((p) => matchesEnvPattern("AWS_SECRET_ACCESS_KEY", p)));
  assert.ok(!MINIMAL_BASELINE.some((p) => matchesEnvPattern("SSH_AUTH_SOCK", p)));
  assert.ok(!MINIMAL_BASELINE.some((p) => matchesEnvPattern("GITHUB_TOKEN", p)));
});

test("empty parent and no policy yields an empty child env", () => {
  const { env, passed, stripped } = buildChildEnv({}, undefined);
  assert.deepEqual(env, {});
  assert.deepEqual(passed, []);
  assert.deepEqual(stripped, []);
});
