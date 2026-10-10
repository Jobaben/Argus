import { createCliProvider, type CliProviderOptions } from "./cli.js";

export {
  DECISION_PROMPT_RENDERER_VERSION,
  renderDecisionPrompt,
  readCliAnswer as readClaudeAnswer,
} from "./cli.js";

export const CLAUDE_CLI_ADAPTER_VERSION = 1;
export type ClaudeCliProviderOptions = Omit<CliProviderOptions, "runtime" | "adapterVersion">;

export function createClaudeCliProvider(opts: ClaudeCliProviderOptions) {
  return createCliProvider({
    ...opts,
    runtime: "claude",
    adapterVersion: CLAUDE_CLI_ADAPTER_VERSION,
  });
}
