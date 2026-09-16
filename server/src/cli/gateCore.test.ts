import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GATE_HELP,
  credentialsFromEnv,
  explainRefusal,
  gateRequest,
  isGateVerb,
  parseGateArgs,
  renderOutcome,
  sessionFromSetCookie,
} from "./gateCore.js";

const env = {} as NodeJS.ProcessEnv;

describe("parseGateArgs", () => {
  it("approve takes an instance id, an optional phase, and the shared options", () => {
    const parsed = parseGateArgs("approve", ["inst-1", "--phase", "review", "--json"], env);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    assert.equal(parsed.options.verb, "approve");
    assert.equal(parsed.options.instanceId, "inst-1");
    assert.equal(parsed.options.phaseId, "review");
    assert.equal(parsed.options.note, null);
    assert.equal(parsed.options.json, true);
    assert.equal(parsed.options.url, "http://127.0.0.1:7777");
    assert.equal(parsed.options.token, null);
  });

  it("reads the port and token from the environment, and lets flags override them", () => {
    const fromEnv = parseGateArgs("approve", ["inst-1"], {
      ARGUS_PORT: "9001",
      ARGUS_TOKEN: " t0k ",
    } as NodeJS.ProcessEnv);
    assert.equal(fromEnv.kind, "ok");
    if (fromEnv.kind !== "ok") return;
    assert.equal(fromEnv.options.url, "http://127.0.0.1:9001");
    assert.equal(fromEnv.options.token, "t0k");
    const flags = parseGateArgs(
      "approve",
      ["inst-1", "--url=http://box:7000/", "--token=other"],
      { ARGUS_TOKEN: "t0k" } as NodeJS.ProcessEnv,
    );
    assert.equal(flags.kind, "ok");
    if (flags.kind !== "ok") return;
    assert.equal(flags.options.url, "http://box:7000");
    assert.equal(flags.options.token, "other");
  });

  it("revise requires a non-blank --note, in either spelling", () => {
    const missing = parseGateArgs("revise", ["inst-1"], env);
    assert.equal(missing.kind, "error");
    if (missing.kind === "error") assert.match(missing.message, /--note/);
    const blank = parseGateArgs("revise", ["inst-1", "--note", "  "], env);
    assert.equal(blank.kind, "error");
    const spaced = parseGateArgs("revise", ["inst-1", "--note", "tighten the intro"], env);
    assert.equal(spaced.kind, "ok");
    if (spaced.kind === "ok") assert.equal(spaced.options.note, "tighten the intro");
    const equals = parseGateArgs("revise", ["--note=shorter", "inst-1"], env);
    assert.equal(equals.kind, "ok");
    if (equals.kind === "ok") {
      assert.equal(equals.options.note, "shorter");
      assert.equal(equals.options.instanceId, "inst-1");
    }
  });

  it("refuses --note on approve, a missing id, two ids, unknown flags and flags without values", () => {
    const cases: [string[], RegExp][] = [
      [["inst-1", "--note", "x"], /belongs to revise/],
      [[], /needs an instance id/],
      [["a", "b"], /one instance id only/],
      [["inst-1", "--bogus"], /unknown option/],
      [["inst-1", "--phase"], /--phase needs a value/],
      [["inst-1", "--phase", "--json"], /--phase needs a value/],
    ];
    for (const [argv, re] of cases) {
      const parsed = parseGateArgs("approve", argv, env);
      assert.equal(parsed.kind, "error", argv.join(" "));
      if (parsed.kind === "error") assert.match(parsed.message, re, argv.join(" "));
    }
  });

  it("--help wins over everything else and names the verb", () => {
    const parsed = parseGateArgs("revise", ["--help"], env);
    assert.deepEqual(parsed, { kind: "help", verb: "revise" });
    assert.match(GATE_HELP.revise, /--note <text>/);
    assert.match(GATE_HELP.approve, /ARGUS_USER/);
    assert.doesNotMatch(GATE_HELP.approve, /--note <text>/);
  });

  it("isGateVerb recognises exactly the two verbs", () => {
    assert.equal(isGateVerb("approve"), true);
    assert.equal(isGateVerb("revise"), true);
    assert.equal(isGateVerb("tail"), false);
    assert.equal(isGateVerb(undefined), false);
  });
});

describe("gateRequest", () => {
  const base = { url: "http://x", token: null, json: false, note: null, phaseId: null };
  it("approve posts to /approve with only the phase, when given", () => {
    assert.deepEqual(gateRequest({ ...base, verb: "approve", instanceId: "i1" }), {
      path: "/api/instances/i1/approve",
      body: {},
    });
    assert.deepEqual(gateRequest({ ...base, verb: "approve", instanceId: "i1", phaseId: "p" }), {
      path: "/api/instances/i1/approve",
      body: { phaseId: "p" },
    });
  });
  it("revise posts the note and the phase", () => {
    assert.deepEqual(
      gateRequest({ ...base, verb: "revise", instanceId: "i1", note: "n", phaseId: "p" }),
      { path: "/api/instances/i1/revise", body: { note: "n", phaseId: "p" } },
    );
  });
});

describe("credentials and sessions", () => {
  it("credentialsFromEnv needs both variables", () => {
    assert.equal(credentialsFromEnv({} as NodeJS.ProcessEnv), null);
    assert.equal(credentialsFromEnv({ ARGUS_USER: "u" } as NodeJS.ProcessEnv), null);
    assert.equal(credentialsFromEnv({ ARGUS_PASSWORD: "p" } as NodeJS.ProcessEnv), null);
    assert.equal(credentialsFromEnv({ ARGUS_USER: "  ", ARGUS_PASSWORD: "p" } as NodeJS.ProcessEnv), null);
    assert.deepEqual(
      credentialsFromEnv({ ARGUS_USER: " usha ", ARGUS_PASSWORD: "pw" } as NodeJS.ProcessEnv),
      { username: "usha", password: "pw" },
    );
  });

  it("sessionFromSetCookie picks the named cookie out of a set-cookie header", () => {
    assert.equal(
      sessionFromSetCookie("argus_session=abc123; Path=/; HttpOnly; SameSite=Strict", "argus_session"),
      "abc123",
    );
    assert.equal(
      sessionFromSetCookie("other=1; Path=/, argus_session=x%3Dy; HttpOnly", "argus_session"),
      "x=y",
    );
    assert.equal(sessionFromSetCookie("other=1; Path=/", "argus_session"), null);
    assert.equal(sessionFromSetCookie(null, "argus_session"), null);
  });
});

describe("renderOutcome", () => {
  const ok = { ok: true, verb: "approve" as const, instanceId: "i1", phaseId: "review", status: 200 };
  it("reads as one line for a human", () => {
    assert.equal(renderOutcome(ok, false), '✓ approved i1 at "review" — the pipeline continues');
    assert.equal(
      renderOutcome({ ...ok, verb: "revise", phaseId: null }, false),
      "↺ sent i1 back to its agent — the phase runs again with your note",
    );
    assert.equal(
      renderOutcome({ ...ok, ok: false, status: 409, error: "not waiting" }, false),
      '✗ could not approve i1 at "review": not waiting',
    );
  });
  it("is the same object as JSON", () => {
    assert.deepEqual(JSON.parse(renderOutcome(ok, true)), ok);
  });
});

describe("explainRefusal", () => {
  it("turns login and gate statuses into a sentence that names the fix", () => {
    assert.match(explainRefusal("login", 401, { code: "auth_setup_required" }, "http://x"), /no account yet/);
    assert.match(explainRefusal("login", 401, { error: "invalid username or password" }, "http://x"), /invalid username/);
    assert.match(explainRefusal("login", 401, null, "http://x"), /ARGUS_TOKEN/);
    assert.match(explainRefusal("login", 403, { code: "pending_approval" }, "http://x"), /root approval/);
    assert.match(explainRefusal("login", 403, null, "http://x"), /Host allowlist/);
    assert.match(explainRefusal("login", 429, null, "http://x"), /too many/);
    assert.equal(explainRefusal("gate", 409, { error: "instance is not awaiting approval" }, "http://x"), "instance is not awaiting approval");
    assert.equal(explainRefusal("gate", 404, null, "http://x"), "no such instance");
    assert.equal(explainRefusal("gate", 500, null, "http://x"), "HTTP 500");
  });
});
