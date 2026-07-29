/**
 * The Omnibar: state a sentence, see exactly what would change, then confirm.
 *
 * "Pause everything touching Starling until Monday" is a perfectly clear
 * instruction and a terrible thing to execute directly. The Omnibar splits it
 * in two: a bounded planning pass turns the sentence into an explicit list of
 * mutations, and nothing is applied until a human reads that list and confirms
 * it. The model chooses; the person decides; the server enforces.
 *
 * Three properties make that safe rather than merely reassuring.
 *
 * **The verbs are a closed set.** {@link MutationKind} is exhaustive, and the
 * server drops anything outside it. A planning pass cannot invent a capability
 * Argus does not already expose behind the same auth.
 *
 * **The targets must already exist.** Every mutation names an id drawn from the
 * catalogue the planner was given, re-checked against live state at execution.
 * A hallucinated schedule name is dropped at compile time, and a schedule that
 * changed between preview and confirm stops the whole plan.
 *
 * **The preview is the contract.** What executes is the stored plan, not the
 * sentence — the intent is never re-interpreted at execution time, so the list
 * you approved is the list that runs.
 */

/** Every mutation the planner is allowed to propose. Exhaustive by design. */
export type MutationKind =
  | "schedule.disable"
  | "schedule.enable"
  | "issue.resolve"
  | "issue.ignore"
  | "instance.abort"
  | "budget.setDaily"
  | "budget.setMonthly";

/**
 * One change, fully resolved: what it touches, what it is now, what it becomes.
 *
 * `before` and `after` are display strings rather than typed values because
 * their only job is to let a human check the plan. Anything the executor needs
 * is in `kind`, `targetId` and `value`.
 */
export interface PlannedMutation {
  kind: MutationKind;
  /** Schedule id, issue fingerprint, or instance id. */
  targetId: string;
  /** Human name, resolved by the server from live state — never the model's. */
  targetLabel: string;
  /** The argument, for the kinds that take one (currently a dollar limit). */
  value: string | number | null;
  /** Current state, for the reader. */
  before: string;
  /** State after this mutation. */
  after: string;
}

export type PlanStatus =
  /** Mutations are ready to preview. */
  | "ready"
  /** The intent was understood, but nothing would change. */
  | "empty"
  /** The planner could not run (budget, concurrency, disabled). */
  | "unavailable"
  /** The intent was understood and deliberately not turned into mutations. */
  | "refused";

export interface Plan {
  /** Opaque handle; execution takes this, never the intent text. */
  id: string;
  status: PlanStatus;
  /** Echoed back so a stale preview is recognisable. */
  intent: string;
  mutations: PlannedMutation[];
  /**
   * Things the reader should know before confirming: a target that was dropped,
   * a verb that was not understood, an interpretation the planner had to guess.
   * Never fatal — a warning is information, not a blocker.
   */
  warnings: string[];
  /** One sentence explaining the plan, or why there is not one. */
  summary: string;
  createdAt: string;
  /** After this, execution is refused and the intent must be re-planned. */
  expiresAt: string;
}

/** A deep link offered alongside an answer. */
export interface AnswerLink {
  label: string;
  href: string;
}

/**
 * An answer to a question about history, rather than a plan to change anything.
 *
 * "When did the nightly triage last fail?" is a question; "pause it" is an
 * instruction. Answering questions inline is most of what a command bar is
 * asked to do, and routing them through a confirm step would be theatre.
 */
export interface OmnibarAnswer {
  text: string;
  links: AnswerLink[];
}

export type OmnibarMode = "plan" | "answer";

export interface OmnibarResponse {
  mode: OmnibarMode;
  plan: Plan | null;
  answer: OmnibarAnswer | null;
}

export type ExecuteStatus =
  /** Every mutation applied. */
  | "applied"
  /** Nothing applied; the plan no longer matches live state. */
  | "stale"
  /** Nothing applied; the plan is unknown or expired. */
  | "expired"
  /** A mutation failed and the earlier ones were reversed. */
  | "rolled-back"
  /**
   * A mutation failed *and* the reversal failed. The one outcome that leaves
   * the system part-changed, reported loudly rather than folded into a generic
   * error, because it is the only case a human must go and check by hand.
   */
  | "partial";

export interface ExecuteResult {
  status: ExecuteStatus;
  /** Mutations that are in effect now. Empty for every status but `applied`. */
  applied: PlannedMutation[];
  /** Mutations that were applied and then reversed. */
  reversed: PlannedMutation[];
  /** Set when something went wrong. */
  error: string | null;
  /** One sentence for the user, always set. */
  summary: string;
}
