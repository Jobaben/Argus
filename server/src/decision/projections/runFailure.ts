import type { DecisionProjection, ObservedTerminationClass, Run } from "@argus/contracts";
import { buildRecording } from "../../sources/recorder.js";
import { observeTermination } from "../observations.js";
import type { ProjectionBuilder } from "../projection.js";
import { BodyShaper, REDACTION_RULES_V1, type RedactionRule } from "../redaction.js";

/**
 * The run-failure projections for the H2 questions (RFC §H.2, §O.4).
 *
 * Two projections, because one cannot both show and hide the observed
 * termination:
 *
 * - `run-failure` v1, for `run.failure-cause.residual`: run metadata, the
 *   observed termination class, status, exit code and error, the prompt, the
 *   result summary and the tail of the transcript timeline;
 * - `run-failure.blind` v1, for `run.termination-probe`: the same trace with
 *   status, outcome, exit code, error string and termination **withheld**.
 *
 * The timeline is built from transcript lines only. The Recorder also adds a
 * terminal event derived from the run record (its status and error), and
 * spreads the run's cost over token bursts; both would leak withheld fields
 * into the blind body, so the Recorder is handed a run with those fields
 * neutralised, and the start, prompt and usage events are dropped (the
 * prompt is carried once, in its own capped field).
 *
 * Deterministic by construction: the Recorder's clock argument is pinned to
 * the run's own timestamps, not the wall clock, so re-deriving a finished
 * run's snapshot reproduces the same bytes while its sources are unchanged.
 */

export const RUN_FAILURE_CAPS = {
  scheduleName: 200,
  prompt: 4000,
  resultSummary: 1000,
  error: 1000,
  eventLabel: 200,
  eventDetail: 200,
  events: 60,
} as const;

const TRUNCATION_RULE = "truncate.code-points@1";
const RULES: readonly RedactionRule[] = REDACTION_RULES_V1;

export const RUN_FAILURE_V1: DecisionProjection = {
  id: "run-failure",
  version: 1,
  subject: "run",
  description:
    "A finished run: metadata, observed termination, status, exit code and error, prompt, result summary, and the last 60 transcript events.",
  maxBytes: 256 * 1024,
  redactionRules: RULES.map((r) => r.id),
  truncation: { rule: TRUNCATION_RULE, caps: { ...RUN_FAILURE_CAPS } },
  withheld: [],
};

export const RUN_FAILURE_BLIND_V1: DecisionProjection = {
  id: "run-failure.blind",
  version: 1,
  subject: "run",
  description:
    "The run-failure trace with every field that states how the run ended withheld, for the termination probe.",
  maxBytes: 256 * 1024,
  redactionRules: RULES.map((r) => r.id),
  truncation: { rule: TRUNCATION_RULE, caps: { ...RUN_FAILURE_CAPS } },
  withheld: ["status", "outcome", "exitCode", "error", "termination", "terminal-event"],
};

export const RUN_FAILURE_BLIND_V2: DecisionProjection = {
  id: "run-failure.blind",
  version: 2,
  subject: "run",
  description:
    "A bounded transcript-only evaluation input. Source metadata, prompt, summary and observed ending are withheld. Transcript-authored hints still require frozen-input audit.",
  maxBytes: 256 * 1024,
  redactionRules: RULES.map((r) => r.id),
  truncation: {
    rule: TRUNCATION_RULE,
    caps: {
      eventLabel: RUN_FAILURE_CAPS.eventLabel,
      eventDetail: RUN_FAILURE_CAPS.eventDetail,
      events: RUN_FAILURE_CAPS.events,
    },
  },
  withheld: [
    "status",
    "outcome",
    "exitCode",
    "error",
    "termination",
    "terminal-event",
    "scheduleName",
    "trigger",
    "runtime",
    "model",
    "durationMs",
    "prompt",
    "resultSummary",
  ],
};

const KEPT_KINDS = new Set(["thinking", "text", "tool", "file", "error"]);

interface TimelineEvent {
  atMs: number;
  kind: string;
  errored: boolean;
  label: string;
  detail?: string;
}

function recorderClock(run: Run): Date {
  for (const t of [run.endedAt, run.startedAt, run.queuedAt]) {
    if (t && Number.isFinite(Date.parse(t))) return new Date(Date.parse(t));
  }
  return new Date(0);
}

function timeline(run: Run, lines: unknown[], shaper: BodyShaper) {
  const neutral: Run = {
    ...run,
    endedAt: null,
    error: null,
    resultSummary: null,
    costUsd: null,
    status: "running",
    outcome: null,
    exitCode: null,
  };
  delete neutral.termination;
  const recording = buildRecording(neutral, lines, recorderClock(run));
  const kept = recording.events.filter((e) => KEPT_KINDS.has(e.kind));
  const tail = kept.slice(-RUN_FAILURE_CAPS.events);
  const offset = kept.length - tail.length;
  const events: TimelineEvent[] = tail.map((e, i) => {
    const at = `/timeline/events/${i}`;
    const ev: TimelineEvent = {
      atMs: Math.max(0, Math.round(e.atMs)),
      kind: e.kind,
      errored: Boolean(e.errored) || e.kind === "error",
      label: shaper.text(`${at}/label`, e.label, RUN_FAILURE_CAPS.eventLabel),
    };
    if (e.detail) ev.detail = shaper.text(`${at}/detail`, e.detail, RUN_FAILURE_CAPS.eventDetail);
    return ev;
  });
  return {
    events,
    omittedEarlier: offset,
    // The Recorder keeps at most its own cap of events; past it, earlier
    // events are gone before we see them and `omittedEarlier` is a floor.
    recorderTruncated: recording.truncated,
  };
}

function builder(blind: boolean, evaluation = false): ProjectionBuilder {
  const def = evaluation ? RUN_FAILURE_BLIND_V2 : blind ? RUN_FAILURE_BLIND_V1 : RUN_FAILURE_V1;
  return {
    id: def.id,
    version: def.version,
    async project(_def, subject, sources) {
      if (subject.kind !== "run") {
        return { ok: false, reason: "subject-mismatch", detail: "not a run subject" };
      }
      const run = await sources.readRun(subject.runId);
      if (!run) {
        return {
          ok: false,
          reason: "source-unavailable",
          detail: `run ${subject.runId} not found`,
        };
      }
      if (run.status === "running") {
        return {
          ok: false,
          reason: "source-unavailable",
          detail: `run ${run.id} has not finished`,
        };
      }
      const lines = await sources.readTranscript(run);
      if (lines === null) {
        return {
          ok: false,
          reason: "source-unavailable",
          detail: `the transcript for run ${run.id} is unavailable`,
        };
      }
      const shaper = new BodyShaper(RULES);
      const meta: Record<string, unknown> = evaluation
        ? {}
        : {
            scheduleName: shaper.text(
              "/run/scheduleName",
              run.scheduleName,
              RUN_FAILURE_CAPS.scheduleName,
            ),
            trigger: run.trigger ?? null,
            runtime: run.runtime ?? "claude",
            model: run.model ?? null,
            durationMs: run.durationMs ?? null,
          };
      if (!blind) {
        const observed = observeTermination(run);
        const termination: { class: ObservedTerminationClass | null; notDerivable?: string } =
          observed.ok ? { class: observed.value } : { class: null, notDerivable: observed.reason };
        meta.status = run.status;
        meta.outcome = run.outcome ?? null;
        meta.exitCode = run.exitCode ?? null;
        meta.error =
          run.error == null ? null : shaper.text("/run/error", run.error, RUN_FAILURE_CAPS.error);
        meta.observedTermination = termination;
      }
      const body = evaluation
        ? { timeline: timeline(run, lines, shaper) }
        : {
            run: meta,
            prompt: shaper.text("/prompt", run.prompt ?? "", RUN_FAILURE_CAPS.prompt),
            resultSummary:
              run.resultSummary == null
                ? null
                : shaper.text("/resultSummary", run.resultSummary, RUN_FAILURE_CAPS.resultSummary),
            timeline: timeline(run, lines, shaper),
          };
      return {
        ok: true,
        content: {
          subject: { kind: "run", runId: run.id },
          refs: { runs: [run.id], claims: [], verifications: [], artifacts: [] },
          // The agent wrote its final message and everything in its transcript.
          subjectAuthored: evaluation
            ? ["/timeline/events"]
            : ["/resultSummary", "/timeline/events"],
          redactions: shaper.redactions(),
          truncations: shaper.truncations(),
          body,
        },
      };
    },
  };
}

export const runFailureBuilder = builder(false);
export const runFailureBlindBuilder = builder(true);

export const runFailureBlindV2Builder = builder(true, true);
