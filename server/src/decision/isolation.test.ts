import * as ts from "typescript";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GateDecision } from "@argus/contracts";
import { argusWorkRoot, paths } from "../claudeHome.js";
import { evaluateSupport } from "../knowledge/kernel.js";
import {
  createClaim,
  createEvidence,
  createJustification,
  readLedger,
} from "../knowledge/store.js";
import { appendGateDecision, readGateDecisions } from "../sources/gateDecisions.js";
import { writeRun } from "../sources/runs.js";
import { deriveCurrency } from "./currency.js";
import {
  BUILTIN_BUILDERS,
  builtinRegistry,
  decisionsRoot,
  defaultSources,
  providerWorkdir,
} from "./definitions.js";
import { DecisionJournal } from "./journal.js";
import { operatorActionObservations, terminationObservations } from "./observations.js";
import { createMockProvider } from "./providers/mock.js";
import { replay } from "./replay.js";
import { createDecisionService } from "./service.js";
import {
  assistant,
  clock,
  failedRun,
  ids,
  RESIDUAL_P,
  tempRoot,
  toolResult,
} from "./testSupport.js";

/**
 * The mandatory ledger-isolation regression (RFC §E.2, §H.5, §O).
 *
 * An assessment is never knowledge. Every Decision Plane operation runs here
 * against Argus's real stores: assess, re-evaluate, replay, currency,
 * observation derivation, archival and explicit deletion. Afterwards every
 * byte Argus keeps outside the journal's own directory is identical. That
 * covers `knowledge.json` (claims, evidence, justifications),
 * `gate-decisions.jsonl`, the run records and the work root. Support, as
 * `evaluateSupport` defines it, is unchanged. The static half proves that no
 * other module imports the Decision Plane, and that the plane imports
 * nothing that writes the ledger, the gate log or pipeline state.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

function tree(dir: string, skip: (p: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (skip(f)) continue;
      if (e.isDirectory()) walk(f);
      else out.set(f, readFileSync(f).toString("base64"));
    }
  };
  walk(dir);
  return out;
}

test("no Decision Plane operation changes a byte of the ledger, the gate log, runs or pipeline state; support is unchanged", async () => {
  const home = tempRoot("argus-isolation-");
  process.env.ARGUS_CLAUDE_HOME = home;
  process.env.ARGUS_WORK_DIR = path.join(home, "work");
  mkdirSync(paths.argus(), { recursive: true });
  const NOW = new Date("2026-09-19T10:00:00.000Z");

  // A small but real ledger: claims, evidence, a justification.
  await createClaim({ id: "FACT-1", kind: "fact", statement: "the config lives in app.toml" }, NOW);
  await createClaim({ id: "RULE-1", kind: "business-rule", statement: "configs are TOML" }, NOW);
  const conclusion = await createClaim({ kind: "conclusion", statement: "c" }, NOW);
  await createEvidence(
    { claim: { id: "FACT-1" }, direction: "supports", source: { type: "run", runId: "run-iso" } },
    NOW,
  );
  await createJustification(
    {
      conclusion: { id: conclusion.id },
      premises: [{ id: "FACT-1" }, { id: "RULE-1" }],
      direction: "supports",
    },
    NOW,
  );
  const decision: GateDecision = {
    id: "GD-iso",
    instanceId: "inst-iso",
    pipelineId: "p",
    decision: "revise",
    mechanism: "operator",
    channel: "http",
    principal: { kind: "session", username: "ana", role: "admin" },
    phases: [{ phaseId: "build", attempt: 0, status: "awaiting-approval", runIds: ["run-iso"] }],
    recordedAt: NOW.toISOString(),
  };
  await appendGateDecision(decision);
  const run = failedRun({ id: "run-iso", project: "-repo", sessionId: "sess-iso" });
  await writeRun(run);
  const session = path.join(paths.projects(), "-repo", "sess-iso.jsonl");
  mkdirSync(path.dirname(session), { recursive: true });
  writeFileSync(
    session,
    [
      assistant(1000, [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat app.toml" } },
      ]),
      toolResult(2000, "t1", "No such file", true),
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );

  const ledgerBefore = await readLedger();
  const supportBefore = ledgerBefore.claims.map((c) => evaluateSupport(ledgerBefore, c));
  const outside = (p: string) =>
    p === decisionsRoot() || p === path.join(paths.argus(), "decision-provider-cwd");
  const before = tree(home, outside);
  assert.ok([...before.keys()].some((f) => f.endsWith("knowledge.json")));
  assert.ok([...before.keys()].some((f) => f.endsWith("gate-decisions.jsonl")));

  // Every operation, over the real stores.
  const c = clock();
  const journal = new DecisionJournal({
    root: decisionsRoot(),
    now: c.now,
    limits: { segmentMaxBytes: 4000 },
  });
  const registry = builtinRegistry();
  const sources = defaultSources();
  const mock = createMockProvider({ script: () => ({ distribution: RESIDUAL_P }) });
  await providerWorkdir();
  const service = createDecisionService({
    journal,
    registry,
    builders: BUILTIN_BUILDERS,
    sources,
    providers: { mock },
    now: c.now,
    newId: ids("DA-iso"),
  });
  const assessed = [];
  for (let i = 0; i < 4; i++) {
    const r = await service.assess({
      question: "run.failure-cause.residual",
      subject: { kind: "run", runId: "run-iso" },
      provider: "mock",
      sample: i,
    });
    assert.ok(r.ok, JSON.stringify(r));
    assessed.push(r.assessment);
  }
  const probe = await service.assess({
    question: "run.termination-probe",
    subject: { kind: "run", runId: "run-iso" },
    provider: "mock",
  });
  assert.ok(probe.ok);
  assert.equal(
    (await deriveCurrency(assessed[0], { registry, builders: BUILTIN_BUILDERS, sources, journal }))
      .status,
    "current",
  );
  await journal.archive();
  const re = await service.reEvaluate({ assessmentId: assessed[0].id, provider: "mock" });
  assert.ok(re.ok);
  await replay(journal, registry);
  const archivedSeg = (await journal.read()).segments.find((s) => s.store === "archive")!.segment;
  await journal.deleteArchivedSegment({
    segment: archivedSeg,
    operator: "ops",
    reason: "isolation test",
  });
  operatorActionObservations(await readGateDecisions());
  terminationObservations([run]);

  // The journal did its work, in its own directory only.
  assert.ok((await journal.read()).entries.length > 0);
  const after = tree(home, outside);
  assert.deepEqual(
    [...after.keys()].sort(),
    [...before.keys()].sort(),
    "no file appeared or vanished outside the journal",
  );
  for (const [f, bytes] of before) assert.equal(after.get(f), bytes, `${f} changed`);

  const ledgerAfter = await readLedger();
  assert.deepEqual(ledgerAfter.claims, ledgerBefore.claims);
  assert.deepEqual(ledgerAfter.evidence, ledgerBefore.evidence);
  assert.deepEqual(ledgerAfter.justifications, ledgerBefore.justifications);
  assert.deepEqual(
    ledgerAfter.claims.map((c) => evaluateSupport(ledgerAfter, c)),
    supportBefore,
  );
  const ledgerText = readFileSync(paths.knowledgeFile(), "utf8");
  assert.ok(!ledgerText.includes("DA-iso"), "no assessment id reached the ledger");
  // The journal lives beside the other stores, never inside the ledger's or the work root.
  assert.ok(!decisionsRoot().startsWith(argusWorkRoot()));
  assert.notEqual(path.dirname(paths.knowledgeFile()), decisionsRoot());
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(f));
    else if (f.endsWith(".ts") && !f.endsWith(".test.ts")) out.push(f);
  }
  return out;
}

function imports(file: string): Array<{ from: string; names: string[] }> {
  const text = readFileSync(file, "utf8");
  const out: Array<{ from: string; names: string[] }> = [];
  const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+"([^"]+)"/g;
  for (const m of text.matchAll(re)) {
    const names = (m[1].match(/\{([\s\S]*)\}/)?.[1] ?? m[1])
      .split(",")
      .map((s) =>
        s
          .replace(/\btype\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    out.push({ from: m[2], names });
  }
  return out;
}

test("outside imports admit experiment entries and only the advisory reader interface", () => {
  const decisionDir = path.join(SRC, "decision");
  // Importer (relative to server/src) → entry module → the only names it may
  // take (RFC §P, §Q), plus the erased advisory API interface. No engine hook or policy.
  const allowed: Record<string, Record<string, Set<string>>> = {
    "index.ts": {
      "decision/experiments.js": new Set(["countAnalysisPasses", "createShadowExperiments"]),
    },
    "app.ts": {
      "decision/h2/entry.js": new Set(["readH2ReportResponse"]),
      "decision/h1/entry.js": new Set(["readH1ReportResponse"]),
      "decision/reader.js": new Set(["DecisionReader"]),
    },
  };
  const offenders: string[] = [];
  for (const f of sourceFiles(SRC)) {
    if (f.startsWith(decisionDir + path.sep)) continue;
    const importer = path.relative(SRC, f).split(path.sep).join("/");
    for (const { from, names } of imports(f)) {
      const target = from.startsWith(".") ? path.resolve(path.dirname(f), from) : from;
      if (!target.startsWith(decisionDir)) continue;
      const entry = path.relative(SRC, target).split(path.sep).join("/");
      for (const n of names) {
        if (!allowed[importer]?.[entry]?.has(n)) offenders.push(`${importer} → ${from}: ${n}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the advisory API imports only the erased DecisionReader interface", () => {
  const app = readFileSync(path.join(SRC, "app.ts"), "utf8");
  const parsed = ts.createSourceFile("app.ts", app, ts.ScriptTarget.Latest, true);
  const readerImports = parsed.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (s) =>
        ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "./decision/reader.js",
    );
  assert.equal(readerImports.length, 1);
  const clause = readerImports[0].importClause;
  assert.ok(clause?.isTypeOnly, "the reader dependency must be an erased type-only import");
  assert.ok(clause.namedBindings && ts.isNamedImports(clause.namedBindings));
  assert.deepEqual(
    clause.namedBindings.elements.map((e) => (e.propertyName ?? e.name).text),
    ["DecisionReader"],
  );
  const emitted = ts.transpileModule(app, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  assert.ok(
    !emitted.includes('from "./decision/reader.js"'),
    "the app must not load the reader factory or journal at runtime",
  );
});
test("dispatch admission interfaces remain erased type-only dependencies", () => {
  const violations: string[] = [];
  for (const file of sourceFiles(path.join(SRC, "decision"))) {
    const parsed = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of parsed.statements.filter(ts.isImportDeclaration)) {
      const clause = statement.importClause;
      if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
      for (const element of clause.namedBindings.elements) {
        if (
          (element.propertyName ?? element.name).text === "AnalysisDispatchAdmission" &&
          !clause.isTypeOnly &&
          !element.isTypeOnly
        ) {
          violations.push(path.relative(SRC, file));
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});
test("the Decision Plane imports only readers from the ledger, the gate log and pipeline state", () => {
  const decisionDir = path.join(SRC, "decision");
  // Module (relative to server/src) → the only names the Decision Plane may import from it.
  const allowed: Record<string, Set<string>> = {
    "knowledge/kernel.js": new Set(["activeRevision", "sameRepositoryState", "KnowledgeLedger"]),
    "knowledge/store.js": new Set(["readLedger"]),
    "sources/instances.js": new Set(["readInstance", "readInstances"]),
    "sources/runs.js": new Set(["readRun", "readRuns"]),
    "sources/budget.js": new Set(["isSpendBlocked"]),
    "log.js": new Set(["log"]),
    "sources/sessions.js": new Set(["readSessionLines"]),
    "sources/recorder.js": new Set(["buildRecording"]),
    "sources/analysis.js": new Set([
      "analysisModel",
      "AnalysisRunner",
      "AnalysisDispatchAdmission",
      "dispatchValidationDetail",
      "prepareDispatchAdmission",
    ]),
    "claudeHome.js": new Set(["paths"]),
    "mutex.js": new Set(["KeyedMutex"]),
    // H1 (RFC §Q.4): the gate drawer's own review model and the records a
    // gate is judged on — each a reader or a pure function. Git is read with
    // --no-optional-locks; nothing here writes, locks an instance or approves.
    "sources/artifacts.js": new Set(["buildPhaseReview", "ReviewResult"]),
    "sources/gateDecisions.js": new Set(["readGateDecisions", "decisionEffect"]),
    "sources/gatePolicy.js": new Set(["autoApprovalQualification", "QualificationBasisEntry"]),
    "sources/pipelines.js": new Set(["readPipelines"]),
    "sources/verdict.js": new Set(["readCurrentVerdicts"]),
    "sources/watchtower.js": new Set(["baselineKey", "buildWatchtower", "readResets"]),
    "harness/invocation.js": new Set(["phaseBaselinePath"]),
    "harness/verification.js": new Set([
      "changedSince",
      "committedSince",
      "diffNumstat",
      "snapshotWorkingTree",
      "DiffNumstat",
      "WorkingTreeSnapshot",
    ]),
    "knowledge/realization.js": new Set(["repositoryStateFrom"]),
    // Byte-level primitives shared with the pipeline transition log: canonical
    // JSON, the checksummed line envelope with its torn-write fence, and
    // write-every-byte/fsync. Each writes only the path it is handed and
    // knows nothing of the ledger, the gate log or pipeline state. They were
    // the plane's own until the transition log needed the same guarantees,
    // and moved out rather than being copied.
    "durable/canonical.js": new Set([
      "CanonicalJsonError",
      "canonicalJson",
      "sha256Hex",
      "canonicalDigest",
      "parseCanonical",
      "SHA256_RE",
    ]),
    "durable/envelope.js": new Set([
      "appendLines",
      "encodeLine",
      "parseLines",
      "readText",
      "TORN_FENCE",
      "TORN_MARKER",
      "tornPrefix",
      "ParsedFile",
      "ParsedLine",
    ]),
    "durable/io.js": new Set([
      "defaultWrite",
      "ShortWriteError",
      "syncDir",
      "writeAll",
      "FaultHook",
      "WriteFn",
    ]),
  };
  const violations: string[] = [];
  for (const f of sourceFiles(decisionDir)) {
    if (path.basename(f) === "testSupport.ts") continue;
    for (const { from, names } of imports(f)) {
      if (!from.startsWith(".")) continue;
      const target = path
        .relative(SRC, path.resolve(path.dirname(f), from))
        .split(path.sep)
        .join("/");
      if (target.startsWith("decision/")) continue;
      const ok = allowed[target];
      for (const n of names) {
        if (!ok?.has(n)) violations.push(`${path.relative(SRC, f)} imports ${n} from ${target}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("an assessment is not an evidence source, and the knowledge contract does not know the decision contract", () => {
  const contracts = path.resolve(SRC, "..", "..", "contracts", "src");
  const knowledge = readFileSync(path.join(contracts, "knowledge.ts"), "utf8");
  const union = knowledge.slice(
    knowledge.indexOf("export type EvidenceSource"),
    knowledge.indexOf(";", knowledge.indexOf("export type EvidenceSource")),
  );
  assert.ok(union.length > 0);
  assert.ok(!/assessment|decision|DA-/i.test(union));
  assert.ok(!knowledge.includes('from "./decision.js"'));
  const decision = readFileSync(path.join(contracts, "decision.ts"), "utf8");
  // The policy contract has no granting effect.
  const effect = decision.match(/effect:\s*([^;]+);/)?.[1] ?? "";
  assert.deepEqual(
    effect
      .split("|")
      .map((s) => s.trim().replace(/"/g, ""))
      .sort(),
    ["escalate", "flag", "withhold-auto-approval"],
  );
});
