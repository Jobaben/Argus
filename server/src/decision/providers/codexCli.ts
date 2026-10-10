import { createCliProvider, type CliProviderOptions } from "./cli.js";
export const CODEX_CLI_ADAPTER_VERSION = 1;
export type CodexCliProviderOptions = Omit<CliProviderOptions, "runtime" | "adapterVersion">;
export function createCodexCliProvider(opts: CodexCliProviderOptions) {
  return createCliProvider({
    ...opts,
    runtime: "codex",
    adapterVersion: CODEX_CLI_ADAPTER_VERSION,
  });
}
