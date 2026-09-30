import type {
  AssessmentCurrency,
  CurrencyCheck,
  CurrencyStatus,
  DecisionAssessment,
  SnapshotContent,
} from "@argus/contracts";
import { activeRevision, sameRepositoryState } from "../knowledge/kernel.js";
import type { DecisionJournal } from "./journal.js";
import { buildSnapshot, type DecisionSources, type ProjectionBuilder } from "./projection.js";
import type { DecisionRegistry } from "./registry.js";

/**
 * Currency: whether an assessment still speaks to the present (RFC §E.2).
 * **Derived on read, never written back** onto the historical record.
 *
 * current ⟺ the question version is the latest registered, the recorded
 * definitions are the registered ones (by digest), the projection re-run now
 * for the same subject hashes to the recorded snapshot, the subject itself
 * has not moved on (a phase attempt that is no longer the phase's attempt is
 * stale), every claim revision the snapshot referenced is still the active
 * revision, and a recorded repository state is still the observed one.
 *
 * Three outcomes, never rounded to each other:
 * - **stale**: some check positively found a change;
 * - **unavailable**: nothing found a change, but some input needed to decide
 *   was missing (a source record gone, a definition not registered, a
 *   projection with no builder). Missing input never reads as current;
 * - **current**: every check that applies passed.
 */

export interface CurrencyDeps {
  registry: DecisionRegistry;
  builders: readonly ProjectionBuilder[];
  sources: DecisionSources;
  journal: DecisionJournal;
}

function check(c: CurrencyCheck["check"], status: CurrencyStatus, detail: string): CurrencyCheck {
  return { check: c, status, detail };
}

export async function deriveCurrency(
  a: DecisionAssessment,
  deps: CurrencyDeps,
): Promise<AssessmentCurrency> {
  const checks: CurrencyCheck[] = [];
  const { registry } = deps;

  const recorded = registry.question(a.question.id, a.question.version);
  if (!recorded) {
    checks.push(
      check(
        "question-definition",
        "unavailable",
        "the recorded question version is not registered",
      ),
    );
  } else if (recorded.ref.digest !== a.question.digest) {
    checks.push(
      check(
        "question-definition",
        "unavailable",
        "the registered definition differs from the one used",
      ),
    );
  } else {
    checks.push(check("question-definition", "current", "registered, digest matches"));
  }

  const latest = registry.latestQuestion(a.question.id);
  if (!latest)
    checks.push(check("question-version", "unavailable", "the question is not registered"));
  else if (latest.def.version !== a.question.version) {
    checks.push(check("question-version", "stale", `superseded by version ${latest.def.version}`));
  } else
    checks.push(
      check("question-version", "current", `version ${a.question.version} is the latest`),
    );

  const projRef = a.snapshot.projection;
  const projection = registry.projection(projRef.id, projRef.version);
  const builder = deps.builders.find((b) => b.id === projRef.id && b.version === projRef.version);
  if (!projection) {
    checks.push(
      check("projection-definition", "unavailable", "the recorded projection is not registered"),
    );
  } else if (projection.ref.digest !== projRef.digest) {
    checks.push(
      check(
        "projection-definition",
        "unavailable",
        "the registered projection differs from the one used",
      ),
    );
  } else {
    checks.push(check("projection-definition", "current", "registered, digest matches"));
  }

  // Re-derive the snapshot identity now, for the same subject.
  let content: SnapshotContent | null = null;
  if (!projection || !builder || projection.ref.digest !== projRef.digest) {
    checks.push(check("snapshot", "unavailable", "the projection cannot be re-run"));
  } else {
    const rebuilt = await buildSnapshot(
      builder,
      projection.ref,
      projection.def,
      a.subject,
      deps.sources,
    );
    if (!rebuilt.ok) {
      checks.push(
        check("snapshot", "unavailable", `cannot re-derive: ${rebuilt.reason}: ${rebuilt.detail}`),
      );
    } else if (rebuilt.snapshot.sha256 !== a.snapshot.sha256) {
      checks.push(check("snapshot", "stale", "the projection re-run now hashes differently"));
    } else {
      checks.push(check("snapshot", "current", "re-derived snapshot matches"));
      content = rebuilt.snapshot.content;
    }
  }
  if (!content) {
    // The references to check are the ones the assessment was actually built from.
    const retained = await deps.journal.loadSnapshot(a.snapshot.sha256);
    if (retained.status === "retained") content = retained.snapshot.content;
  }

  checks.push(await subjectCheck(a, deps.sources));

  if (!content) {
    checks.push(
      check(
        "claim-revisions",
        "unavailable",
        "the snapshot is not retained, so its references are unknown",
      ),
    );
  } else if (content.refs.claims.length > 0) {
    const ledger = await deps.sources.readLedger();
    if (!ledger) checks.push(check("claim-revisions", "unavailable", "the ledger cannot be read"));
    else {
      let status: CurrencyStatus = "current";
      const notes: string[] = [];
      for (const ref of content.refs.claims) {
        const active = activeRevision(ledger, ref.id);
        if (!active) {
          if (status === "current") status = "unavailable";
          notes.push(`${ref.id} is not in the ledger`);
        } else if (active.revision !== ref.revision) {
          status = "stale";
          notes.push(`${ref.id}@${ref.revision} superseded by @${active.revision}`);
        }
      }
      checks.push(
        check("claim-revisions", status, notes.join("; ") || "every referenced revision is active"),
      );
    }
  }

  if (content?.repository) {
    const now = await deps.sources.repositoryState(a.subject, content.repository);
    if (!now)
      checks.push(
        check("repository-state", "unavailable", "the current repository state is unknown"),
      );
    else if (!sameRepositoryState(content.repository, now)) {
      checks.push(
        check("repository-state", "stale", "the repository has moved from the assessed state"),
      );
    } else checks.push(check("repository-state", "current", "same repository state"));
  }

  const status: CurrencyStatus = checks.some((c) => c.status === "stale")
    ? "stale"
    : checks.some((c) => c.status === "unavailable")
      ? "unavailable"
      : "current";
  return { assessmentId: a.id, status, checks };
}

async function subjectCheck(
  a: DecisionAssessment,
  sources: DecisionSources,
): Promise<CurrencyCheck> {
  const s = a.subject;
  switch (s.kind) {
    case "run": {
      const run = await sources.readRun(s.runId);
      return run
        ? check("subject", "current", `run ${s.runId} is recorded`)
        : check("subject", "unavailable", `run ${s.runId} is no longer recorded`);
    }
    case "phase-attempt": {
      const inst = await sources.readInstance(s.instanceId);
      if (!inst)
        return check("subject", "unavailable", `instance ${s.instanceId} is no longer recorded`);
      const phase = inst.phases.find((p) => p.id === s.phaseId);
      if (!phase)
        return check("subject", "unavailable", `phase ${s.phaseId} is not in the instance`);
      return phase.attempt === s.attempt
        ? check("subject", "current", `attempt ${s.attempt} is the phase's attempt`)
        : check(
            "subject",
            "stale",
            `the phase moved from attempt ${s.attempt} to ${phase.attempt}`,
          );
    }
    case "rule-verification":
    case "acceptance-verification": {
      const ledger = await sources.readLedger();
      if (!ledger) return check("subject", "unavailable", "the ledger cannot be read");
      const list =
        s.kind === "rule-verification" ? ledger.verifications : ledger.acceptanceVerifications;
      return list.some((v) => v.id === s.verificationId)
        ? check("subject", "current", `${s.verificationId} is recorded`)
        : check("subject", "unavailable", `${s.verificationId} is not in the ledger`);
    }
  }
}
