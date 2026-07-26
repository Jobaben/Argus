/**
 * Schedule-domain types — all wire shapes, so they live in `@argus/contracts`
 * and are re-exported here for the scheduler, the engine and the sources that
 * already import them from this path.
 */

export type {
  Run,
  RunOutcome,
  RunStatus,
  Schedule,
  ScheduleInput,
  ScheduleWithNext,
  Trigger,
  TriggerKind,
} from "@argus/contracts";
