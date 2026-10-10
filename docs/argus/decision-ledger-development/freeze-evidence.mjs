import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const root = process.argv[2];
if (!root) throw new Error("source evidence checkout required");
const dir = path.join(root, "experiments/decision-ledger-closeout-20261009/reports");
const files = [
  "final-report.md",
  "development-plan.md",
  "implementation-backlog.json",
  "consumer-matrix.json",
  "experiment-results.json",
  "evidence-audit.json",
  "independent-closeout-plan-review.json",
  "material-failure-diagnosis.json",
  "final-cutoff-verification.json",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const evidence = files.map((name) => {
  const bytes = readFileSync(path.join(dir, name));
  return {
    path: `experiments/decision-ledger-closeout-20261009/reports/${name}`,
    bytes: bytes.length,
    sha256: hash(bytes),
  };
});
const audit = JSON.parse(readFileSync(path.join(dir, "evidence-audit.json"), "utf8"));
const results = JSON.parse(readFileSync(path.join(dir, "experiment-results.json"), "utf8"));
const questions = audit.cases.flatMap((c) =>
  c.questions.map((q) => ({
    case: c.case,
    pipelineId: c.pipelineId,
    runId: q.runId,
    question: q.question,
    disposition: q.collectionOutcome,
    assessmentId: q.assessmentId ?? null,
  })),
);
const tally = Object.fromEntries(
  ["assessed", "not-selected", "excluded"].map((k) => [
    k,
    questions.filter((q) => q.disposition === k).length,
  ]),
);
if (
  questions.length !== 32 ||
  tally.assessed !== 22 ||
  tally["not-selected"] !== 6 ||
  tally.excluded !== 4
)
  throw new Error("closeout population mismatch");
const historical = JSON.parse(
  readFileSync(
    path.join(
      root,
      "experiments/decision-ledger-closeout-20261009/baseline/application-code-hashes.json",
    ),
    "utf8",
  ),
);
const presentComparison = historical.map((h) => {
  try {
    const bytes = readFileSync(path.join(root, h.path));
    return { path: h.path, matches: hash(bytes) === h.sha256 };
  } catch {
    return { path: h.path, matches: false, missing: true };
  }
});
const output = {
  format: "argus.decision-ledger-development-evidence",
  version: 1,
  source: {
    baseCommit: "02668069d8eb1f716757f0acb26a5d1021ad3013",
    sourceCopy: "C:/GIT/Argus/.worktrees/argus-local",
    trackedLedgerCheckout: "C:/GIT/Argus/.worktrees/h2-codex-support",
    runningBuild: "unavailable; no current build identity established",
    preexistingProviderChangesImported: false,
  },
  evidence,
  questions,
  tally,
  historicalSourceComparison: {
    checked: presentComparison.length,
    mismatches: presentComparison.filter((x) => !x.matches),
  },
  measuredByHistoricalExperiment: {
    selected: 22,
    answered: 20,
    providerFailed: 2,
    independentHumanResidualReferences: 0,
    probeCorrectAnswered: 14,
    probeAnswered: 15,
    knownAssessmentCostUsd: results.ownedAssessmentCost.knownUsd,
    unknownAssessmentCostRecords: 2,
    integrity: results.verification.nativeReportIntegrity,
  },
  limitations: [
    "Historical report assertions are evidence, not verification of new consumers",
    "Both correct deadlines contain schedule-name labels",
    "Normal process/tool denial misclassification demonstrates taxonomy weakness, not model authority",
    "No prospective genuine labels, calibration, enforcing safety or running build proof",
    "Account model catalog membership does not establish CLI account compatibility",
    "No uncertain provider invocation automatically resent",
  ],
};
writeFileSync(
  "docs/argus/decision-ledger-development/evidence-manifest.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    evidenceFiles: evidence.length,
    questions: questions.length,
    tally,
    sourceFilesChecked: presentComparison.length,
    sourceMismatches: output.historicalSourceComparison.mismatches.length,
  }),
);
