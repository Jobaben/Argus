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

export const HOOK_VERSION: number;
export function classifyMarker(
  message: unknown,
): "succeeded" | "failed" | "blocked" | "missing" | "conflicting";
export function lastMessage(payload: unknown): string;
export function hasPendingBackgroundWork(payload: unknown): boolean;
export function resolveType(argType: string | undefined, payload: unknown): string;
export function buildReason(payload: unknown): string;
export function readResultFile(file: string | undefined): {
  result?: unknown;
  resultError?: string;
};
/** A string body is sent as is; anything else is serialized as JSON. */
export function deliverSignal(
  url: string,
  body: unknown,
  fetchImpl?: typeof globalThis.fetch,
  timeoutMs?: number,
): Promise<void>;
export const DELIVERY_BUDGET_MS: number;
export const DELIVERY_BACKOFF_MS: readonly number[];
export function deliverWithRetry(
  url: string,
  body: unknown,
  options?: {
    fetchImpl?: typeof globalThis.fetch;
    budgetMs?: number;
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<void>;
