import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  PhaseFailurePayload,
  PipelineInstance,
  RuleVerificationRecord,
} from "@argus/contracts";
import { createEngine } from "../pipelineEngine.js";
import type { Engine } from "../pipelineEngine.js";
import { createPipeline, readPipelines, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance } from "../sources/instances.js";
import { readInvocation } from "../sources/runs.js";
import { buildPhaseReview } from "../sources/artifacts.js";
import { readJournal } from "../sources/journal.js";
import { readVerificationRecord, stagedVerificationPath } from "./verificationStaging.js";
import { createClaim, createEvidence, createRevision, readLedger } from "./store.js";
import { evaluateSupport, formatClaimRef, ruleConformance } from "./kernel.js";
import { analyzeImpact } from "./impact.js";

/**
 * Business-rule verification through the engine (Phase 6).
 *
 * The whole workflow on a real repository fixture and a real gate:
 *
 *   canonical rule → KnowledgeContext → verification agent → staged proposal
 *     → deterministic checks → gate → durable conformance
 *
 * Every assertion is on the ledger on disk, the staged record, the persisted
 * instance or the review payload. The agent is a spawn double whose "work" is
 * the test writing the verification file before signalling, so nothing here
 * depends on a model: every binding, refusal and commit is computed by Argus.
 *
 * The regression the suite exists for is the first test in
 * "§ Support versus conformance": a violated implementation must leave its
 * rule exactly as supported as it was.
 */

let home: string;
let repo: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-verify-engine-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
  repo = makeRepo(180);
});

const NOW = new Date("2026-09-20T10:00:00.000Z");
let counter = 0;

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function git(dir: string, ...args: string[]) {
  return spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], {
    cwd: dir,
    stdio: "ignore",
  });
}

/** The fixture: a validator that caps the customer comment at `max`. */
function validatorSource(max: number): string {
  return [
    "public static class KobraCommentValidator",
    "{",
    `    public const int MaxLength = ${max};`,
    "",
    "    public static bool IsValid(string comment) =>",
    "        comment is null || comment.Length <= MaxLength;",
    "}",
    "",
  ].join("\n");
}

function makeRepo(max: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-verify-repo-"));
  mkdirSync(path.join(dir, "src", "Booking"), { recursive: true });
  writeFileSync(path.join(dir, "src", "Booking", "KobraCommentValidator.cs"), validatorSource(max));
  if (gitAvailable()) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

/** Change the implementation and commit, so a later run gets a new gitHead. */
function reimplement(max: number): void {
  writeFileSync(
    path.join(repo, "src", "Booking", "KobraCommentValidator.cs"),
    validatorSource(max),
  );
  if (gitAvailable()) {
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", `max ${max}`);
  }
}

function headOf(dir: string): string | null {
  if (!gitAvailable()) return null;
  const out = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : null;
}

interface Spawned {
  runId: string;
  env: Record<string, string>;
  cwd: string;
}

function recordingSpawn() {
  const calls: Spawned[] = [];
  const spawn = (run: { id: string; cwd: string }, _log: string, env: Record<string, string>) => {
    calls.push({ runId: run.id, env, cwd: run.cwd });
    return { pid: 2000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, calls };
}

function engine(spawn: ReturnType<typeof recordingSpawn>["spawn"]) {
  return createEngine({
    now: () => new Date(),
    newId: () => `id-${++counter}`,
    spawn,
    signalUrlBase: "http://localhost:7778",
    maxConcurrent: 4,
    tickMs: 30000,
    parentEnv: { PATH: process.env.PATH ?? "/bin", HOME: home },
  });
}

async function seed(phases: Record<string, unknown>[]) {
  return createPipeline(
    validatePipelineInput({
      name: "verification",
      trigger: null,
      phases: phases.map((p) => ({ cwd: repo, gated: false, ...p })),
    }),
    NOW,
    "p1",
  );
}

const step = (name = "verify", prompt = "check the validator") => ({ name, prompt });

/** One canonical, supported business rule, as a discovery phase would have
 *  left it. Returns its exact ref. */
async function seedRule(
  id = "RULE-42",
  statement = "Kobra customer comments must not exceed 180 characters.",
) {
  const claim = await createClaim({ id, kind: "business-rule", statement }, NOW);
  await createEvidence(
    {
      claim: { id, revision: claim.revision },
      direction: "supports",
      source: { type: "human", who: "domain owner" },
    },
    NOW,
  );
  return { id: claim.id, revision: claim.revision };
}

/** The verification phase the suite reuses: gated, supplied RULE-42's active
 *  revision through an ordinary KnowledgeContext. */
const verifyPhase = (over: Record<string, unknown> = {}) => ({
  id: "verify",
  name: "Verify",
  gated: true,
  steps: [step()],
  knowledgeContext: { claims: [{ id: "RULE-42", revision: "active" }] },
  ruleVerification: {},
  ...over,
});

function writeVerification(call: Spawned, report: unknown) {
  const file = call.env.ARGUS_RULE_VERIFICATION_FILE;
  assert.ok(file, "a verification run must be told where its report goes");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof report === "string" ? report : JSON.stringify(report));
}

const sourceEvidence = (head: string | null, over: Record<string, unknown> = {}) => ({
  type: "source-code",
  path: "src/Booking/KobraCommentValidator.cs",
  ...(head ? { gitHead: head } : {}),
  symbol: "KobraCommentValidator.MaxLength",
  startLine: 3,
  endLine: 6,
  ...over,
});

const holdsFor = (head: string | null, rule = "RULE-42:v1") => ({
  schemaVersion: 1,
  verifications: [
    {
      rule,
      outcome: "holds",
      evidence: [sourceEvidence(head)],
      note: "MaxLength is 180 and IsValid enforces it",
    },
  ],
  metadata: { summary: "The validator enforces the 180-character limit." },
});

async function complete(e: Engine, inst: PipelineInstance, phaseId: string, runId: string) {
  return e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId,
    runId,
    type: "completed",
    token: inst.signalToken,
    payload: { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" },
  });
}

async function instance(id: string): Promise<PipelineInstance> {
  const inst = await readInstance(id);
  assert.ok(inst);
  return inst;
}

async function definition() {
  return (await readPipelines()).find((p) => p.id === "p1");
}

const phaseOf = (inst: PipelineInstance, id: string) => inst.phases.find((p) => p.id === id)!;
const failure = (inst: PipelineInstance, id: string) =>
  (phaseOf(inst, id).payload ?? {}) as PhaseFailurePayload;

// ── Backwards compatibility ─────────────────────────────────────────────────

test("no ruleVerification policy: an ordinary pipeline behaves exactly as before Phase 6", async () => {
  await seed([{ id: "plan", name: "Plan", steps: [step("s", "p")] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  // No channel, no environment variable, no instruction.
  assert.equal(rec.calls[0].env.ARGUS_RULE_VERIFICATION_FILE, undefined);
  const invocation = await readInvocation(rec.calls[0].runId);
  assert.equal(invocation?.ruleVerificationFile, null);
  assert.equal(
    (invocation?.channels ?? []).some((c) => c.kind === "rule-verification"),
    false,
  );
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal("ruleVerification" in phaseOf(after, "plan"), false);
  assert.deepEqual((await readLedger()).verifications, []);
});

// ── Holds ───────────────────────────────────────────────────────────────────

test("a verified rule is staged, not durable, until the gate is approved", async () => {
  const rule = await seedRule();
  await seed([verifyPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const runId = rec.calls[0].runId;
  const invocation = await readInvocation(runId);
  const head = invocation?.gitHead ?? null;

  // The run was told which rules it is accountable for, and where to answer.
  const file = rec.calls[0].env.ARGUS_RULE_VERIFICATION_FILE;
  assert.ok(file);
  assert.equal(invocation?.ruleVerificationFile, file);
  const channel = (invocation?.channels ?? []).find((c) => c.kind === "rule-verification");
  assert.equal(channel?.required, true);
  assert.equal(channel?.access, "write");

  writeVerification(rec.calls[0], holdsFor(head));
  await complete(e, inst, "verify", runId);
  await e.drain();

  const parked = await instance(inst.id);
  assert.equal(phaseOf(parked, "verify").status, "awaiting-approval");
  assert.equal(phaseOf(parked, "verify").steps[0].ruleVerification?.status, "staged");
  assert.deepEqual(phaseOf(parked, "verify").ruleVerification, {
    selected: 1,
    holds: 1,
    violated: 0,
    unverifiable: 0,
    requiresReview: true,
  });
  // Nothing durable yet.
  assert.deepEqual((await readLedger()).verifications, []);
  assert.equal(ruleConformance(await readLedger(), rule).status, "unverified");

  await e.approve(inst.id);
  await e.drain();

  const done = await instance(inst.id);
  assert.equal(done.status, "succeeded");
  assert.equal(phaseOf(done, "verify").steps[0].ruleVerification?.status, "applied");
  assert.equal(phaseOf(done, "verify").ruleVerification?.requiresReview, false);

  const ledger = await readLedger();
  assert.equal(ledger.verifications.length, 1);
  const durable = ledger.verifications[0];
  assert.deepEqual(durable.rule, rule);
  assert.equal(durable.outcome, "holds");
  assert.equal(durable.execution.runId, runId);
  assert.equal(durable.execution.phaseId, "verify");
  assert.equal(durable.repository?.gitHead, head ?? undefined);
  assert.equal(durable.evidence[0].type, "source-code");
  // And the sidecar record keeps what it became.
  const record = await readVerificationRecord(runId);
  assert.equal(record?.status, "applied");
  assert.deepEqual(
    record?.result?.verifications.map((v) => v.id),
    [durable.id],
  );
});

// ── Support versus conformance ──────────────────────────────────────────────

test("MANDATORY REGRESSION: a violated implementation does not contest the rule", async () => {
  const rule = await seedRule();
  const before = await readLedger();
  assert.equal(evaluateSupport(before, rule), "supported");
  const evidenceBefore = before.evidence.length;
  const justificationsBefore = before.justifications.length;
  const claimsBefore = before.claims.length;

  await seed([verifyPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      {
        rule: formatClaimRef(rule),
        outcome: "violated",
        evidence: [sourceEvidence(head)],
        note: "MaxLength is 500, so a 400-character comment is accepted",
      },
    ],
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  const after = await readLedger();
  // The rule is untouched, in every respect that decides its support.
  assert.equal(evaluateSupport(after, rule), "supported");
  assert.equal(after.evidence.length, evidenceBefore);
  assert.equal(after.justifications.length, justificationsBefore);
  assert.equal(after.claims.length, claimsBefore);
  // No opposing evidence was created — the specific contamination Phase 6 forbids.
  assert.equal(
    after.evidence.some((ev) => ev.direction === "opposes"),
    false,
  );
  // Conformance carries the bad news instead.
  assert.equal(ruleConformance(after, rule, head ?? undefined).status, "violated");
  // And the rule is not "impacted": support did not change, so nothing depends
  // differently on it.
  const impact = analyzeImpact(after, rule);
  assert.deepEqual(impact.root.conditions, []);
  assert.deepEqual(impact.semantic.affectedClaims, []);
});

// ── Unverifiable ────────────────────────────────────────────────────────────

test("unverifiable is recorded explicitly, with the verifier's reason", async () => {
  const rule = await seedRule();
  await seed([verifyPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      {
        rule: formatClaimRef(rule),
        outcome: "unverifiable",
        evidence: [],
        reason: "no test or validator in this scope expresses a comment-length limit",
      },
    ],
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  const ledger = await readLedger();
  const conformance = ruleConformance(ledger, rule);
  assert.equal(conformance.status, "unverifiable");
  assert.match(conformance.latest!.reason!, /no test or validator/);
  // Not the same as never having looked.
  assert.notEqual(conformance.status, "unverified");
});

// ── Completeness ────────────────────────────────────────────────────────────

test("a selected rule left out of the result refuses the whole proposal", async () => {
  await seedRule("RULE-A", "Rule A");
  await seedRule("RULE-B", "Rule B");
  await seedRule("RULE-C", "Rule C");
  await seed([
    verifyPhase({
      gated: false,
      knowledgeContext: {
        claims: [
          { id: "RULE-A", revision: "active" },
          { id: "RULE-B", revision: "active" },
          { id: "RULE-C", revision: "active" },
        ],
      },
    }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      { rule: "RULE-A:v1", outcome: "holds", evidence: [{ type: "observation", note: "a" }] },
      { rule: "RULE-B:v1", outcome: "violated", evidence: [{ type: "observation", note: "b" }] },
    ],
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.equal(failure(after, "verify").failureClass, "rule-verification");
  assert.match(failure(after, "verify").reason ?? "", /RULE-C:v1 is missing/);
  // Nothing partial: A and B did not land either.
  assert.deepEqual((await readLedger()).verifications, []);
  assert.equal((await readVerificationRecord(rec.calls[0].runId))?.status, "rejected");
});

test("a rule the phase was not supplied refuses the whole proposal", async () => {
  await seedRule();
  await seedRule("RULE-D", "An unrelated rule");
  await seed([verifyPhase({ gated: false })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      { rule: "RULE-42:v1", outcome: "holds", evidence: [{ type: "observation", note: "ok" }] },
      { rule: "RULE-D:v1", outcome: "holds", evidence: [{ type: "observation", note: "d" }] },
    ],
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.match(failure(after, "verify").reason ?? "", /RULE-D:v1 was not supplied to this run/);
  assert.deepEqual((await readLedger()).verifications, []);
});

test("a verification phase that wrote no file at all is refused, not quietly succeeded", async () => {
  await seedRule();
  await seed([verifyPhase({ gated: false })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.equal(failure(after, "verify").failureClass, "rule-verification");
  assert.match(failure(after, "verify").reason ?? "", /wrote no rule-verification file/);
});

// ── Exact revision binding ──────────────────────────────────────────────────

test("a proposal for the wrong revision of a supplied rule is refused", async () => {
  await seedRule();
  await createRevision(
    "RULE-42",
    { statement: "Kobra customer comments must not exceed 500 characters." },
    NOW,
  );
  await seed([verifyPhase({ gated: false })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  // The context supplied v2 (the active revision); the agent answers for v1.
  writeVerification(rec.calls[0], holdsFor(null, "RULE-42:v1"));
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.match(failure(after, "verify").reason ?? "", /RULE-42:v2 is missing/);
  assert.deepEqual((await readLedger()).verifications, []);
});

test("a rule revised after verification leaves v1's history and starts v2 unverified", async () => {
  const v1 = await seedRule();
  await seed([verifyPhase({ gated: false })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeVerification(rec.calls[0], holdsFor(head));
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");

  const v2 = await createRevision(
    "RULE-42",
    { statement: "Kobra customer comments must not exceed 500 characters." },
    NOW,
  );
  const ledger = await readLedger();
  assert.equal(ruleConformance(ledger, v1).status, "holds");
  assert.equal(ruleConformance(ledger, { id: v2.id, revision: v2.revision }).status, "unverified");
  // Nothing was retargeted: the record still names v1.
  assert.deepEqual(ledger.verifications[0].rule, v1);
});

// ── Repository binding ──────────────────────────────────────────────────────

test(
  "a later commit is unverified, however the earlier one came out",
  { skip: !gitAvailable() },
  async () => {
    const rule = await seedRule();
    await seed([verifyPhase({ gated: false })]);
    const rec = recordingSpawn();
    const e = engine(rec.spawn);
    const inst = (await e.start("p1", "manual"))!;
    const first = (await readInvocation(rec.calls[0].runId))!.gitHead!;
    writeVerification(rec.calls[0], holdsFor(first));
    await complete(e, inst, "verify", rec.calls[0].runId);
    await e.drain();

    reimplement(500);
    const second = headOf(repo)!;
    assert.notEqual(first, second);

    const ledger = await readLedger();
    assert.equal(ruleConformance(ledger, rule, first).status, "holds");
    // Argus never reports an older commit's conclusion as a statement about a
    // newer one.
    assert.equal(ruleConformance(ledger, rule, second).status, "unverified");
  },
);

// ── Deterministic check linkage ─────────────────────────────────────────────

test("a verification bound to a passing phase check records what Argus itself observed", async () => {
  const rule = await seedRule();
  await seed([
    verifyPhase({
      gated: false,
      checks: [
        { kind: "command", run: 'node -e "process.exit(0)"', label: "comment-length-tests" },
      ],
      ruleVerification: { holds: "deterministic-check" },
    }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      {
        rule: formatClaimRef(rule),
        outcome: "holds",
        evidence: [
          { type: "check", label: "comment-length-tests", note: "covers 180 and 181" },
          sourceEvidence(head),
        ],
      },
    ],
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(phaseOf(after, "verify").verification?.status, "passed");
  const durable = (await readLedger()).verifications[0];
  const cited = durable.evidence.find((ev) => ev.type === "check");
  assert.ok(cited && cited.type === "check");
  // The agent named the check; Argus said how it went.
  assert.equal(cited.label, "comment-length-tests");
  assert.equal(cited.status, "passed");
  assert.equal(cited.exitCode, 0);
  assert.equal(durable.policy, "deterministic-check");
});

test("a forged check reference refuses the whole proposal", async () => {
  await seedRule();
  await seed([
    verifyPhase({
      gated: false,
      checks: [
        { kind: "command", run: 'node -e "process.exit(0)"', label: "comment-length-tests" },
      ],
    }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      {
        rule: "RULE-42:v1",
        outcome: "holds",
        evidence: [{ type: "check", label: "a-test-that-was-never-declared" }],
      },
    ],
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.match(failure(after, "verify").reason ?? "", /this phase does not declare/);
  assert.deepEqual((await readLedger()).verifications, []);
});

test("under deterministic-check, holds with only an observation is refused", async () => {
  await seedRule();
  await seed([verifyPhase({ gated: false, ruleVerification: { holds: "deterministic-check" } })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      {
        rule: "RULE-42:v1",
        outcome: "holds",
        evidence: [{ type: "observation", note: "the code looks right to me" }],
      },
    ],
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.match(failure(after, "verify").reason ?? "", /report it as unverifiable instead/);
});

// ── Atomic commit ───────────────────────────────────────────────────────────

test("ten rules commit together or not at all", async () => {
  const rules = [];
  for (let i = 0; i < 10; i++) rules.push(await seedRule(`RULE-${i}`, `Rule number ${i}`));
  await seed([
    verifyPhase({
      gated: false,
      knowledgeContext: { claims: rules.map((r) => ({ id: r.id, revision: "active" })) },
    }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: rules.map((r, i) => ({
      rule: formatClaimRef(r),
      outcome: i === 3 ? "violated" : i === 7 ? "unverifiable" : "holds",
      ...(i === 7
        ? { evidence: [], reason: "nothing in the tree expresses this rule" }
        : { evidence: [{ type: "observation", note: `checked rule ${i}` }] }),
    })),
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();

  const ledger = await readLedger();
  assert.equal(ledger.verifications.length, 10);
  assert.equal(ledger.verifications.filter((v) => v.outcome === "holds").length, 8);
  assert.equal(ledger.verifications.filter((v) => v.outcome === "violated").length, 1);
  assert.equal(ledger.verifications.filter((v) => v.outcome === "unverifiable").length, 1);
  assert.deepEqual(phaseOf(await instance(inst.id), "verify").ruleVerification, {
    selected: 10,
    holds: 8,
    violated: 1,
    unverifiable: 1,
    requiresReview: false,
  });
});

test("a verification-only commit journals a verification, never an empty delta commit", async () => {
  await seedRule();
  await seed([verifyPhase({ gated: false })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeVerification(rec.calls[0], holdsFor(null));
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();

  const kinds = (await readJournal(inst.id)).map((j) => j.kind);
  assert.equal(kinds.includes("verification.staged"), true);
  assert.equal(kinds.includes("verification.applied"), true);
  // The phase committed no delta, so it does not claim to have committed one.
  assert.equal(kinds.includes("knowledge.applied"), false);
});

test("a cited check the phase's report does not contain refuses the commit as rule-verification", async () => {
  const rule = await seedRule();
  await seed([
    verifyPhase({
      gated: true,
      checks: [{ kind: "command", run: 'node -e "process.exit(0)"', label: "tests" }],
    }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      {
        rule: formatClaimRef(rule),
        outcome: "holds",
        evidence: [{ type: "check", label: "tests" }],
      },
    ],
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();
  const parked = await instance(inst.id);
  assert.equal(parked.status, "awaiting-approval");
  assert.equal(phaseOf(parked, "verify").verification?.status, "passed");

  // Tamper with the staged record while the gate waits, as a forged citation
  // that slipped past intake would look at the boundary: the label is no
  // longer one Argus's own report accounts for.
  const file = stagedVerificationPath(rec.calls[0].runId);
  const staged = JSON.parse(readFileSync(file, "utf8")) as RuleVerificationRecord;
  staged.report!.verifications[0].evidence = [{ type: "check", label: "a-check-nobody-ran" }];
  writeFileSync(file, JSON.stringify(staged));

  await e.approve(inst.id);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.equal(failure(after, "verify").failureClass, "rule-verification");
  assert.match(failure(after, "verify").reason ?? "", /verification report does not contain/);
  // Nothing durable, and the staged record says why.
  assert.deepEqual((await readLedger()).verifications, []);
  assert.equal((await readVerificationRecord(rec.calls[0].runId))?.status, "rejected");
});

// ── Gate lifecycle ──────────────────────────────────────────────────────────

test("revise: the revised attempt's proposal is superseded and can never become durable", async () => {
  await seedRule();
  await seed([verifyPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const first = rec.calls[0].runId;
  writeVerification(rec.calls[0], holdsFor(null));
  await complete(e, inst, "verify", first);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "awaiting-approval");

  await e.revise(inst.id, "check the tests too, not just the constant");
  await e.drain();
  assert.equal((await readVerificationRecord(first))?.status, "superseded");

  const second = rec.calls[1].runId;
  assert.notEqual(second, first);
  writeVerification(rec.calls[1], {
    schemaVersion: 1,
    verifications: [
      {
        rule: "RULE-42:v1",
        outcome: "violated",
        evidence: [{ type: "observation", note: "the tests assert 500" }],
      },
    ],
  });
  await complete(e, inst, "verify", second);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  const ledger = await readLedger();
  // Only the accepted attempt's conclusion is durable.
  assert.equal(ledger.verifications.length, 1);
  assert.equal(ledger.verifications[0].outcome, "violated");
  assert.equal(ledger.verifications[0].execution.runId, second);
  assert.equal((await readVerificationRecord(first))?.status, "superseded");
});

test("retry: a failed attempt's proposal never becomes durable; the successful one does", async () => {
  await seedRule();
  await seed([
    verifyPhase({
      gated: false,
      retry: { attempts: 2, backoffSeconds: 0, retryOn: ["rule-verification"] },
    }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  // Attempt 1 answers for a rule it was never given.
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      { rule: "RULE-99:v1", outcome: "holds", evidence: [{ type: "observation", note: "x" }] },
    ],
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();
  assert.equal((await readVerificationRecord(rec.calls[0].runId))?.status, "rejected");
  assert.deepEqual((await readLedger()).verifications, []);

  await e.reconcile();
  await e.drain();
  assert.equal(rec.calls.length, 2, "the phase retried");
  writeVerification(rec.calls[1], holdsFor(null));
  await complete(e, inst, "verify", rec.calls[1].runId);
  await e.drain();

  const ledger = await readLedger();
  assert.equal(ledger.verifications.length, 1);
  assert.equal(ledger.verifications[0].execution.runId, rec.calls[1].runId);
});

test("restart: an awaiting-approval proposal survives a new engine process and commits correctly", async () => {
  const rule = await seedRule();
  await seed([verifyPhase()]);
  const rec = recordingSpawn();
  const e1 = engine(rec.spawn);
  const inst = (await e1.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeVerification(rec.calls[0], holdsFor(head));
  await complete(e1, inst, "verify", rec.calls[0].runId);
  await e1.drain();
  assert.equal((await instance(inst.id)).status, "awaiting-approval");
  assert.deepEqual((await readLedger()).verifications, []);

  // A fresh process, same home: everything it needs is on disk.
  const e2 = engine(recordingSpawn().spawn);
  await e2.reconcile();
  assert.equal((await readVerificationRecord(rec.calls[0].runId))?.status, "staged");
  await e2.approve(inst.id);
  await e2.drain();

  const ledger = await readLedger();
  assert.equal(ledger.verifications.length, 1);
  assert.equal(ruleConformance(ledger, rule, head ?? undefined).status, "holds");
  assert.equal((await instance(inst.id)).status, "succeeded");
});

// ── The review surface ──────────────────────────────────────────────────────

test("the gate shows the outcomes, the evidence and the rule's own support", async () => {
  await seedRule();
  await seed([verifyPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      {
        rule: "RULE-42:v1",
        outcome: "violated",
        evidence: [sourceEvidence(head)],
        note: "MaxLength is 500",
      },
    ],
    metadata: { summary: "The validator no longer enforces the documented limit." },
  });
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();

  const review = await buildPhaseReview(await instance(inst.id), "verify", await definition());
  assert.equal(review.ok, true);
  assert.ok(review.ok);
  const previews = review.review.ruleVerifications!;
  assert.equal(previews.length, 1);
  assert.equal(previews[0].violated.length, 1);
  const row = previews[0].violated[0];
  assert.equal(row.ref, "RULE-42:v1");
  assert.equal(row.statement, "Kobra customer comments must not exceed 180 characters.");
  // The distinction, visible without reading a transcript.
  assert.equal(row.support, "supported");
  assert.equal(row.outcome, "violated");
  assert.equal(previews[0].summary, "The validator no longer enforces the documented limit.");
  assert.equal(review.review.ruleVerification?.violated, 1);
});

// ── Discovery → implementation → verification ───────────────────────────────

test("a discovered rule is implemented, then verified against the exact revision it became", async () => {
  await seed([
    {
      id: "discover",
      name: "Discover",
      gated: true,
      steps: [step("investigate", "read the validator")],
      discovery: { scope: { paths: ["src/Booking"] }, evidence: "warn" },
    },
    {
      id: "verify",
      name: "Verify",
      gated: false,
      needs: ["discover"],
      steps: [step()],
      knowledgeContext: { fromPhases: [{ phaseId: "discover", kinds: ["business-rule"] }] },
      ruleVerification: {},
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const discoverRun = rec.calls[0].runId;
  const head = (await readInvocation(discoverRun))?.gitHead ?? null;

  // Discovery proposes the rule the validator appears to enforce.
  const deltaFile = rec.calls[0].env.ARGUS_KNOWLEDGE_DELTA_FILE!;
  mkdirSync(path.dirname(deltaFile), { recursive: true });
  writeFileSync(
    deltaFile,
    JSON.stringify({
      schemaVersion: 1,
      claims: [
        {
          localId: "comment-limit",
          kind: "business-rule",
          statement: "Kobra customer comments must not exceed 180 characters.",
        },
      ],
      evidence: [
        {
          claim: { local: "comment-limit" },
          source: {
            type: "source-code",
            path: "src/Booking/KobraCommentValidator.cs",
            ...(head ? { gitHead: head } : {}),
            startLine: 3,
            endLine: 6,
          },
        },
      ],
    }),
  );
  await complete(e, inst, "discover", discoverRun);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  const ledger = await readLedger();
  const rule = ledger.claims.find((c) => c.kind === "business-rule")!;
  const ref = { id: rule.id, revision: rule.revision };

  // The verification run received exactly that revision, minted a moment ago —
  // no prompt could have named it in advance.
  const verifyCall = rec.calls[1];
  const supplied = ledger.supplied.find((s) => s.execution.runId === verifyCall.runId);
  assert.deepEqual(supplied?.claims, [ref]);
  const contextFile = verifyCall.env.ARGUS_KNOWLEDGE_CONTEXT_FILE!;
  const context = JSON.parse(readFileSync(contextFile, "utf8"));
  assert.deepEqual(
    context.claims.map((c: { ref: string }) => c.ref),
    [formatClaimRef(ref)],
  );

  writeVerification(verifyCall, {
    schemaVersion: 1,
    verifications: [
      {
        rule: formatClaimRef(ref),
        outcome: "holds",
        evidence: [sourceEvidence(head)],
      },
    ],
  });
  await complete(e, inst, "verify", verifyCall.runId);
  await e.drain();

  const after = await readLedger();
  assert.equal((await instance(inst.id)).status, "succeeded");
  assert.equal(after.verifications.length, 1);
  assert.deepEqual(after.verifications[0].rule, ref);
  assert.equal(
    ruleConformance(after, ref, after.verifications[0].repository?.gitHead).status,
    "holds",
  );
});

// ── The delta a verification phase may not write ────────────────────────────

test("a verification run that opposes its own rule in a delta is refused outright", async () => {
  const rule = await seedRule();
  await seed([verifyPhase({ gated: false })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;

  // The honest conformance result…
  writeVerification(rec.calls[0], {
    schemaVersion: 1,
    verifications: [
      {
        rule: formatClaimRef(rule),
        outcome: "violated",
        evidence: [{ type: "observation", note: "MaxLength is 500" }],
      },
    ],
  });
  // …plus the contamination Phase 6 forbids.
  const deltaFile = rec.calls[0].env.ARGUS_KNOWLEDGE_DELTA_FILE!;
  mkdirSync(path.dirname(deltaFile), { recursive: true });
  writeFileSync(
    deltaFile,
    JSON.stringify({
      schemaVersion: 1,
      evidence: [
        {
          claim: formatClaimRef(rule),
          direction: "opposes",
          source: { type: "source-code", path: "src/Booking/KobraCommentValidator.cs" },
          note: "the code disagrees, so maybe the rule is wrong",
        },
      ],
    }),
  );
  await complete(e, inst, "verify", rec.calls[0].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.match(failure(after, "verify").reason ?? "", /one of the rules it was supplied to verify/);
  // Neither half landed: the rule keeps its support and gains no conformance.
  const ledger = await readLedger();
  assert.equal(evaluateSupport(ledger, rule), "supported");
  assert.equal(
    ledger.evidence.some((ev) => ev.direction === "opposes"),
    false,
  );
  assert.deepEqual(ledger.verifications, []);
});

// ── The staged file is not the ledger ───────────────────────────────────────

test("a verification file written by a run whose phase never succeeds stays noncanonical", async () => {
  await seedRule();
  await seed([verifyPhase({ gated: false })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeVerification(rec.calls[0], holdsFor(null));
  // The run fails rather than completing.
  await e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId: "verify",
    runId: rec.calls[0].runId,
    type: "failed",
    token: inst.signalToken,
    payload: { reason: "the agent gave up" },
  });
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.deepEqual((await readLedger()).verifications, []);
  // The file exists on disk and is simply not the ledger.
  assert.equal(existsSync(rec.calls[0].env.ARGUS_RULE_VERIFICATION_FILE!), true);
});
