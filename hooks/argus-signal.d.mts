/**
 * Type declarations for the reference stop-hook script. The implementation
 * stays plain .mjs so users can drop it into ~/.claude/hooks or ~/.codex/hooks
 * unmodified — one file serves both runtimes.
 */
export interface StopHookPayload {
  /** Both CLIs name the agent's closing words this; the reader also accepts
   *  `last_agent_message` / `last_message` as insurance against a rename. */
  last_assistant_message?: string;
  /** Claude Code only: deferred work still in flight at Stop time. */
  background_tasks?: Array<{ id?: string; type?: string; status?: string }>;
  [key: string]: unknown;
}

export function lastMessage(payload: unknown): string;
export function hasPendingBackgroundWork(payload: unknown): boolean;
export function resolveType(argType: string | undefined, payload: unknown): string;
export function buildReason(payload: unknown): string;
