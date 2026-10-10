import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson } from "../../../server/dist/decision/canonical.js";
const [evidenceRoot, snapshotRoot] = process.argv.slice(2);
if (!evidenceRoot || !snapshotRoot)
  throw new Error("explicit read-only evidence and snapshot roots required");
const audit = JSON.parse(
  readFileSync(
    path.join(
      evidenceRoot,
      "experiments/decision-ledger-closeout-20261009/reports/evidence-audit.json",
    ),
    "utf8",
  ),
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const patterns = {
  caseIdentifier:
    /\b(?:case|probe)\s*[-:=]?\s*[DEIMNPT][1-4]\b|\bcontrolled\s+(?:case|probe)\b|\b[DEIMNPT][1-4]\b/i,
  expectedAnswerAssertion:
    /\b(?:expected|correct|ground[- ]truth|reference)\s+(?:class|label|answer|outcome|termination)\b|\b(?:class|label|answer)\s*[:=]\s*(?:deadline|never[- ]ran|ended[- ]normally|permission[- ]denied)/i,
  processVocabulary:
    /deadline|ended[- ]normally|permission[- ]denied|never[- ]ran|\b(?:timeout|timed out|denied|exit code)\b/i,
};
const rows = audit.interventionAssessments
  .filter((a) => a.question.id === "run.termination-probe")
  .map((a) => {
    const hash = a.snapshot.sha256;
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid retained hash");
    let bytes;
    try {
      bytes = readFileSync(path.join(snapshotRoot, hash.slice(0, 2), hash + ".json"));
    } catch {
      return { assessmentId: a.id, snapshotSha256: hash, status: "unavailable" };
    }
    if (sha(bytes) !== hash || bytes.length !== a.snapshot.bytes)
      return { assessmentId: a.id, snapshotSha256: hash, status: "integrity-mismatch" };
    const content = JSON.parse(bytes.toString("utf8"));
    const timeline = content.body?.timeline;
    if (!timeline || !Array.isArray(timeline.events))
      return { assessmentId: a.id, snapshotSha256: hash, status: "timeline-unavailable" };
    const candidates = [];
    timeline.events.forEach((event, index) => {
      for (const field of ["label", "detail"]) {
        const value = event[field];
        if (typeof value !== "string") continue;
        for (const [kind, pattern] of Object.entries(patterns)) {
          if (pattern.test(value))
            candidates.push({
              pointer: "/body/timeline/events/" + index + "/" + field,
              kind,
              valueSha256: sha(value),
              valueBytes: Buffer.byteLength(value),
            });
        }
      }
    });
    return {
      assessmentId: a.id,
      snapshotSha256: hash,
      snapshotBytes: bytes.length,
      status: "retained-verified",
      question: a.question,
      projection: content.projection,
      timelineSha256: sha(canonicalJson(timeline)),
      eventCount: timeline.events.length,
      candidates,
      disposition: candidates.some((c) => c.kind !== "processVocabulary")
        ? "requires-case-or-answer-hint-review"
        : "no-pattern-detected-not-blinding-proof",
    };
  });
const result = {
  format: "argus.retained-trace-audit",
  version: 1,
  method:
    "Read-only exact retained V1 probe snapshot timeline audit; no new projection, provider call, historical reinterpretation or human reference label",
  limitations: [
    "Pattern scan cannot establish absence of semantic hints",
    "Process vocabulary can be legitimate evidence; flagged words are not automatically leakage",
    "V2 preserves subject-authored timeline; future exact rendered inputs still require pre-elicitation audit",
    "Case intent and reviewer conclusions are not ground truth",
  ],
  rows,
};
writeFileSync(
  "docs/argus/decision-ledger-development/retained-trace-audit.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    probes: rows.length,
    verified: rows.filter((r) => r.status === "retained-verified").length,
    caseOrAnswerHintRecords: rows.filter((r) =>
      r.candidates?.some((c) => c.kind !== "processVocabulary"),
    ).length,
    processVocabularyRecords: rows.filter((r) =>
      r.candidates?.some((c) => c.kind === "processVocabulary"),
    ).length,
  }),
);
