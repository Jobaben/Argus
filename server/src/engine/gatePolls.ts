import { readInstances } from "../sources/instances.js";
import { readPipelines } from "../sources/pipelines.js";
import { journal } from "../sources/journal.js";
import { hasWaitingGate } from "../sources/instanceStatus.js";
import {
  approvalConditionEligibility,
  conditionFailureReason,
  conditionOutcome,
} from "../sources/gatePolicy.js";
import { checkLabel, runCommand } from "../harness/verification.js";
import type {
  ApprovalCondition,
  PhaseDef,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
} from "../sources/pipelineTypes.js";
import { log } from "../log.js";
import {
  APPROVAL_OUTPUT_TAIL_CHARS,
  APPROVAL_POLL_SLACK_MS,
  APPROVAL_POLL_TIMEOUT_SECONDS,
} from "./constants.js";
import type { EngineCore, EngineFns } from "./context.js";

/** One phase attempt's polling, in this process's memory only — never on the
 *  instance. A restart forgets it, so a new process polls on its first tick
 *  and journals its first result again. */
interface PollRecord {
  /** `deps.now()` when the latest poll was queued. */
  queuedAt: number;
  /** What the latest poll observed, so the journal records only a change. */
  seen: string | null;
  /** The poll in flight, to cut at shutdown; null when none is. */
  running: AbortController | null;
}

/** `text`, cut to `max` characters with an ellipsis. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Approval conditions (DL-A3): polling the gates whose phase declares
 * `approveWhen`, off the instance lock, and handing what a poll saw to the
 * gate decisions (`approveOnCondition`, `failOnCondition`), which decide again
 * under the lock. Queued from the scheduler tick right after `reconcile`;
 * never inside it, and never awaited by it.
 */
export function createGatePolls(core: EngineCore) {
  const { deps, nowISO, track } = core.ctx;
  const approveOnCondition: EngineFns["approveOnCondition"] = (...args) =>
    core.fns.approveOnCondition(...args);
  const failOnCondition: EngineFns["failOnCondition"] = (...args) =>
    core.fns.failOnCondition(...args);
  const commandEnv: EngineFns["commandEnv"] = (...args) => core.fns.commandEnv(...args);

  /** Keyed `instance:phase:attempt`. Pruned every pass. */
  const polls = new Map<string, PollRecord>();
  /** Attempts already journalled as not polled because their gate commits knowledge. */
  const withheld = new Set<string>();
  let stopped = false;

  /**
   * One pass: queue a poll for every phase attempt that may be polled and is
   * due. Selection only — it never waits for a command — and it never rejects:
   * a throw would skip every watcher after it on the tick.
   */
  async function pollGates(): Promise<void> {
    if (stopped) return;
    try {
      const now = deps.now().getTime();
      const [defs, instances] = await Promise.all([readPipelines(), readInstances()]);
      const live = new Set<string>();
      const stillWithheld = new Set<string>();
      for (const inst of instances) {
        try {
          if (!hasWaitingGate(inst)) continue;
          // Recovery's: reconcile has just completed it, or could not.
          if (inst.pendingGateOperation) continue;
          // An instance whose pipeline was deleted is left for the operator to
          // stop, as the board and the Verdict watcher leave it.
          if (!defs.some((d) => d.id === inst.pipelineId)) continue;
          // The instance's own snapshot decides: an edit to `approveWhen`
          // reaches only the next start.
          const def = inst.definition ?? defs.find((d) => d.id === inst.pipelineId);
          if (!def) continue;
          for (const phase of inst.phases) {
            const phaseDef = def.phases.find((p) => p.id === phase.id);
            const key = `${inst.id}:${phase.id}:${phase.attempt}`;
            const eligible = approvalConditionEligibility(phase, phaseDef);
            if (!eligible.ok && eligible.cause === "knowledge") {
              stillWithheld.add(key);
              if (!withheld.has(key)) {
                withheld.add(key);
                await journal(inst.id, {
                  at: nowISO(),
                  kind: "phase.approval-condition",
                  phaseId: phase.id,
                  attempt: phase.attempt,
                  detail:
                    `not polled: this gate commits knowledge (${eligible.reasons.join(", ")}) ` +
                    "and needs a person",
                });
              }
              continue;
            }
            if (!eligible.ok || !phaseDef) continue;
            live.add(key);
            const record = polls.get(key);
            if (record?.running) continue;
            const everyMs = eligible.condition.everySeconds * 1000;
            if (record && now - record.queuedAt < everyMs - APPROVAL_POLL_SLACK_MS) continue;
            if (stopped) return;
            queuePoll(
              key,
              def,
              phaseDef,
              inst,
              phase,
              eligible.condition,
              now,
              record?.seen ?? null,
            );
          }
        } catch (e) {
          log.warn("approval polls of an instance could not be queued", {
            instanceId: inst.id,
            err: e,
          });
        }
      }
      for (const [key, record] of polls) {
        if (!live.has(key) && !record.running) polls.delete(key);
      }
      for (const key of withheld) if (!stillWithheld.has(key)) withheld.delete(key);
    } catch (e) {
      log.error("approval polls could not be queued", { err: e });
    }
  }

  /** One poll, detached and tracked, so `drain()` and shutdown see it. */
  function queuePoll(
    key: string,
    def: PipelineDefinition,
    phaseDef: PhaseDef,
    inst: PipelineInstance,
    phase: PhaseProgress,
    condition: ApprovalCondition,
    now: number,
    seen: string | null,
  ): void {
    const running = new AbortController();
    const record: PollRecord = { queuedAt: now, seen, running };
    polls.set(key, record);
    const label = condition.label ?? checkLabel({ kind: "command", run: condition.run });
    const at = { instanceId: inst.id, phaseId: phase.id, attempt: phase.attempt };
    void track(
      (async () => {
        // Exactly what a command check of this attempt is given.
        const env = await commandEnv(def, phaseDef, inst, phase);
        const startedAt = nowISO();
        const ran = await runCommand(
          {
            kind: "command",
            run: condition.run,
            label,
            ...(condition.cwd ? { cwd: condition.cwd } : {}),
            timeoutSeconds: condition.timeoutSeconds ?? APPROVAL_POLL_TIMEOUT_SECONDS,
          },
          {
            // Where the work is: the phase's worktree when it has one.
            cwd: phase.workspace?.path ?? phaseDef.cwd,
            artifactDir: phase.artifactDir ?? null,
            baseline: null,
            now: deps.now,
            env,
          },
          running.signal,
        );
        // Cut at shutdown: what it saw is discarded, never acted on.
        if (stopped || ran.end === "aborted") return;
        const outcome = conditionOutcome(condition, {
          end: ran.end,
          exitCode: ran.result.exitCode,
        });
        const output = (ran.result.output ?? "").slice(-APPROVAL_OUTPUT_TAIL_CHARS);
        let observed: string;
        let detail: string;
        if (outcome.kind === "approve") {
          const res = await approveOnCondition({
            ...at,
            basis: {
              kind: "command",
              label,
              exitCode: 0,
              output,
              startedAt,
              durationMs: ran.result.durationMs,
            },
          });
          const why = res.error ?? String(res.code);
          observed = res.ok ? "approved" : `approve refused: ${why}`;
          detail = res.ok
            ? `${ran.result.detail}: approved the gate`
            : `exit 0, not applied: ${why}`;
          if (res.ok) log.info("gate approved by its approval condition", at);
          else log.warn("approval condition passed; the approval was refused", { ...at, why });
        } else if (outcome.kind === "fail") {
          const reason = conditionFailureReason(label, outcome.exitCode, output);
          const res = await failOnCondition({ ...at, exitCode: outcome.exitCode, reason });
          const why = res.error ?? String(res.code);
          observed = res.ok ? "failed" : `fail refused: ${why}`;
          detail = res.ok
            ? `exit ${outcome.exitCode}: failed the phase`
            : `exit ${outcome.exitCode}, not applied: ${why}`;
          if (res.ok) log.info("phase failed by its approval condition", at);
          else log.warn("approval condition failed; the failure was refused", { ...at, why });
        } else {
          // Never the duration: an unchanged result must not read as new.
          observed = `wait: ${ran.end === "exit" ? `exit ${ran.result.exitCode}` : ran.result.detail}`;
          detail = `waiting: ${ran.result.detail}`;
        }
        if (observed !== record.seen) {
          record.seen = observed;
          // Awaited (journal never throws): off the transition path, and a
          // drain() then finds it on disk.
          await journal(inst.id, {
            at: nowISO(),
            kind: "phase.approval-condition",
            phaseId: phase.id,
            attempt: phase.attempt,
            detail: clip(`${label}: ${detail}`, 300),
          });
        }
      })()
        .catch((e: unknown) => log.error("approval poll failed", { ...at, err: e }))
        .finally(() => {
          record.running = null;
        }),
    );
  }

  /** Shutdown: cut every poll in flight and queue no more. */
  function stopPolls(): void {
    stopped = true;
    for (const record of polls.values()) record.running?.abort();
  }

  return { pollGates, stopPolls };
}
