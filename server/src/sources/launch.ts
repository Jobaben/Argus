import { existsSync, statSync } from "node:fs";

/** Runs fired ad hoc from the Launch tab share one run bucket: they are pruned
 * together (same RUN_KEEP window as a schedule) and grouped into one Chronicle
 * lane, while never matching a real schedule id in the monitors derivation. */
export const ONEOFF_SCHEDULE_ID = "oneoff";

export class LaunchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchValidationError";
  }
}

export interface LaunchInput {
  name: string;
  prompt: string;
  cwd: string;
  model?: string;
}

export function validateLaunchInput(raw: unknown): LaunchInput {
  if (!raw || typeof raw !== "object") throw new LaunchValidationError("body required");
  const r = raw as Record<string, unknown>;
  if (typeof r.prompt !== "string" || !r.prompt.trim()) {
    throw new LaunchValidationError("prompt is required");
  }
  if (typeof r.cwd !== "string" || !r.cwd.trim()) {
    throw new LaunchValidationError("cwd is required");
  }
  if (!existsSync(r.cwd) || !statSync(r.cwd).isDirectory()) {
    throw new LaunchValidationError(`cwd does not exist: ${r.cwd}`);
  }
  if (r.name !== undefined && typeof r.name !== "string") {
    throw new LaunchValidationError("name must be a string");
  }
  if (r.model !== undefined && (typeof r.model !== "string" || !r.model.trim())) {
    throw new LaunchValidationError("model must be a non-empty string");
  }
  const prompt = r.prompt.trim();
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : deriveName(prompt);
  return {
    name,
    prompt,
    cwd: r.cwd,
    ...(r.model !== undefined ? { model: (r.model as string).trim() } : {}),
  };
}

/** An unnamed launch is titled by its prompt's first line, ellipsized. */
function deriveName(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0].trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}
