import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { TERMINATION_PROBE_V1 } from "../../../server/dist/decision/definitions.js";
import { renderDecisionPrompt } from "../../../server/dist/decision/providers/claudeCli.js";
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
const sha = (b) => createHash("sha256").update(b).digest("hex");
const rows = audit.interventionAssessments
  .filter((a) => a.question.id === "run.termination-probe")
  .map((a) => {
    const hash = a.snapshot.sha256;
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid retained hash");
    let bytes;
    try {
      bytes = readFileSync(path.join(snapshotRoot, hash.slice(0, 2), hash + ".json"));
    } catch {
      return { assessmentId: a.id, runId: a.runId, snapshotSha256: hash, status: "unavailable" };
    }
    if (sha(bytes) !== hash || bytes.length !== a.snapshot.bytes)
      return { assessmentId: a.id, snapshotSha256: hash, status: "integrity-mismatch" };
    const content = JSON.parse(bytes.toString("utf8"));
    const rendered = renderDecisionPrompt(TERMINATION_PROBE_V1, {
      sha256: hash,
      bytes: bytes.length,
      content,
    });
    const metadata = [
      ["/body/run/scheduleName", content.body?.run?.scheduleName],
      ["/body/prompt", content.body?.prompt],
      ["/body/resultSummary", content.body?.resultSummary],
    ];
    const hints = metadata
      .filter(
        ([, v]) =>
          typeof v === "string" &&
          /deadline|ended.normally|permission.denied|missing.context|model.refusal|expected.class|\b(?:D|E|I|M|N|P|T)[1-4]\b/i.test(
            v,
          ),
      )
      .map(([pointer]) => pointer);
    return {
      assessmentId: a.id,
      runId: a.runId,
      snapshotSha256: hash,
      snapshotBytes: bytes.length,
      status: "retained-verified",
      question: a.question,
      projection: content.projection,
      renderedPromptSha256: sha(rendered),
      renderedPromptBytes: Buffer.byteLength(rendered),
      metadataHintPointers: hints,
      subjectAuthored: content.subjectAuthored,
      disposition: hints.length
        ? "class-bearing-metadata-or-case-identifiers-present"
        : "requires-trace-audit",
    };
  });
writeFileSync(
  "docs/argus/decision-ledger-development/historical-input-audit.json",
  JSON.stringify(
    {
      format: "argus.frozen-evaluation-input-audit",
      version: 1,
      method:
        "Direct read of exact retained snapshot bytes and production V1 prompt rendering; no provider calls, store writes or labels",
      limitations: [
        "Metadata hint detection identifies audit candidates, not inference accuracy",
        "V1 meaning is preserved; no historical answer rewritten",
        "Transcript hints and fixture intent are not independent references",
        "V2 tests prove omission only; every future retained rendered prompt requires pre-elicitation audit",
      ],
      rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    probes: rows.length,
    verified: rows.filter((r) => r.status === "retained-verified").length,
    metadataHintRecords: rows.filter((r) => r.metadataHintPointers?.length).length,
  }),
);
