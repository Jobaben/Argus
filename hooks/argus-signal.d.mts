/**
 * Type declarations for the reference Stop-hook script. The implementation
 * stays plain .mjs so users can drop it into ~/.claude/hooks unmodified.
 */
export interface StopHookPayload {
  last_assistant_message?: string;
  background_tasks?: Array<{ id?: string; type?: string; status?: string }>;
  [key: string]: unknown;
}

export function hasPendingBackgroundWork(payload: unknown): boolean;
export function resolveType(
  argType: string | undefined,
  payload: unknown,
): string;
