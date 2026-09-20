#!/usr/bin/env node
/**
 * A fake headless CLI agent, for the harness end-to-end suite.
 *
 * This is deliberately **not** a mock of the pipeline engine's spawn seam: the
 * suite points `ARGUS_CLAUDE_BIN` at this file, so the real
 * `defaultPipelineSpawn` → `spawnPipelineProcess` starts it as a detached child
 * with the prompt on stdin, the argv the Claude Code runtime built, and the
 * child environment the harness's env policy produced. Everything the engine
 * believes about an agent process — argv, environment, stdout transcript, the
 * Stop hook's HTTP signal, the exit code, the process tree it kills at a
 * deadline — is exercised for real.
 *
 * What it does:
 *   1. reads the whole prompt from stdin;
 *   2. records what it was handed in `$ARGUS_ARTIFACT_DIR/seen.json`, so a test
 *      can assert on argv/env/cwd from the child's own point of view;
 *   3. executes the `FAKE: ...` directives the prompt carries, in order;
 *   4. prints a plausible `--output-format stream-json` transcript whose final
 *      message ends with the `ARGUS_OUTCOME:` line the engine's contract asks
 *      for, and whose last line is the CLI result envelope (cost, tokens);
 *   5. fires Argus's real Stop hook exactly as Claude Code would — through the
 *      `hooks.Stop[0].hooks[0].command` of the `--settings` file the invocation
 *      materialized, with the Stop payload on stdin — and exits.
 *
 * Directives (one per prompt line, executed in order):
 *   FAKE: write-artifact <name> <text...>   write a file in ARGUS_ARTIFACT_DIR
 *   FAKE: write-file <relpath> <text...>    write a file under cwd (mkdir -p)
 *   FAKE: write-result <json>               write ARGUS_RESULT_FILE
 *   FAKE: malformed-result                  write `{not json` to ARGUS_RESULT_FILE
 *   FAKE: write-delta <json>                write ARGUS_KNOWLEDGE_DELTA_FILE (a KnowledgeDelta)
 *   FAKE: write-verification <json>         write ARGUS_RULE_VERIFICATION_FILE verbatim
 *   FAKE: verify-context <outcome> <note>   write ARGUS_RULE_VERIFICATION_FILE, giving every rule
 *                                           in ARGUS_KNOWLEDGE_CONTEXT_FILE the same outcome with
 *                                           one source-code evidence record and, when the phase
 *                                           declares one, the named check (canonical ids are
 *                                           minted at an earlier phase's commit, so no prompt can
 *                                           name them). Syntax:
 *                                             verify-context <holds|violated|unverifiable> \
 *                                               <path> [check:<label>] <note...>
 *   FAKE: read-context <name>               copy ARGUS_KNOWLEDGE_CONTEXT_FILE into ARGUS_ARTIFACT_DIR/<name>
 *                                           (proves the agent could read the context it was supplied)
 *   FAKE: consume-context <relpath|->       write a KnowledgeDelta declaring every ref in
 *                                           ARGUS_KNOWLEDGE_CONTEXT_FILE as consumed, optionally with
 *                                           a repository artifact (canonical ids are minted at an
 *                                           earlier phase's commit, so no prompt can name them)
 *   FAKE: sleep <ms>                        stay alive for <ms>
 *   FAKE: exit <code>                       process exit code (default 0)
 *   FAKE: outcome <succeeded|failed|blocked> [reason]   the ARGUS_OUTCOME line
 *   FAKE: no-signal                         skip the Stop hook entirely
 *   FAKE: fail-first <abs-counter-file>     crash (exit 1, no signal) unless the
 *                                           counter file already exists
 *
 * Node builtins only, and it never blocks forever: stdin reading is capped, and
 * any internal error exits 2 with a message on stderr.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The real hook shipped in the repo, resolved from this file's own location. */
const REPO_HOOK = fileURLToPath(new URL("../../../hooks/argus-signal.mjs", import.meta.url));

const STDIN_CAP_MS = 10_000;

const argv = process.argv.slice(2);

function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The whole prompt, or whatever arrived inside the cap (never hangs). */
async function readStdin() {
  const chunks = [];
  const collect = (async () => {
    for await (const chunk of process.stdin) chunks.push(chunk);
  })();
  await Promise.race([collect.catch(() => {}), delay(STDIN_CAP_MS)]);
  return Buffer.concat(chunks).toString("utf8");
}

function writeFileAt(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

function recordSeen(prompt) {
  const dir = process.env.ARGUS_ARTIFACT_DIR;
  if (!dir) return;
  writeFileAt(
    path.join(dir, "seen.json"),
    `${JSON.stringify(
      {
        argv,
        envNames: Object.keys(process.env).sort(),
        cwd: process.cwd(),
        hasArgusToken: "ARGUS_TOKEN" in process.env,
        prompt,
      },
      null,
      2,
    )}\n`,
  );
}

/** `FAKE:` lines, in prompt order, with the prefix stripped. */
function directives(prompt) {
  return prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("FAKE:"))
    .map((line) => line.slice("FAKE:".length).trim())
    .filter((line) => line.length > 0);
}

/**
 * Run the prompt's directives. Returns the run's shape: exit code, the outcome
 * the final message reports, whether the Stop hook fires, and whether the run
 * "crashed" (so no result envelope is printed).
 */
async function execute(prompt) {
  const state = { exitCode: 0, outcome: "succeeded", reason: "", signal: true, crashed: false };
  for (const directive of directives(prompt)) {
    const space = directive.indexOf(" ");
    const name = space === -1 ? directive : directive.slice(0, space);
    const rest = space === -1 ? "" : directive.slice(space + 1).trim();
    switch (name) {
      case "write-artifact": {
        const dir = process.env.ARGUS_ARTIFACT_DIR;
        if (!dir) throw new Error("write-artifact without ARGUS_ARTIFACT_DIR");
        const cut = rest.indexOf(" ");
        const file = cut === -1 ? rest : rest.slice(0, cut);
        const text = cut === -1 ? "" : rest.slice(cut + 1);
        writeFileAt(path.join(dir, file), `${text}\n`);
        break;
      }
      case "write-file": {
        const cut = rest.indexOf(" ");
        const rel = cut === -1 ? rest : rest.slice(0, cut);
        const text = cut === -1 ? "" : rest.slice(cut + 1);
        writeFileAt(path.resolve(process.cwd(), rel), `${text}\n`);
        break;
      }
      case "write-result": {
        const file = process.env.ARGUS_RESULT_FILE;
        if (!file) throw new Error("write-result without ARGUS_RESULT_FILE");
        writeFileAt(file, rest);
        break;
      }
      case "malformed-result": {
        const file = process.env.ARGUS_RESULT_FILE;
        if (!file) throw new Error("malformed-result without ARGUS_RESULT_FILE");
        writeFileAt(file, "{not json");
        break;
      }
      case "write-delta": {
        const file = process.env.ARGUS_KNOWLEDGE_DELTA_FILE;
        if (!file) throw new Error("write-delta without ARGUS_KNOWLEDGE_DELTA_FILE");
        writeFileAt(file, rest);
        break;
      }
      case "write-verification": {
        const file = process.env.ARGUS_RULE_VERIFICATION_FILE;
        if (!file) throw new Error("write-verification without ARGUS_RULE_VERIFICATION_FILE");
        writeFileAt(file, rest);
        break;
      }
      case "verify-context": {
        // "The agent read the rules it was given and answered for every one of
        // them" — the one thing a verification step must be able to do that a
        // static prompt cannot, because the canonical refs were minted when an
        // earlier phase committed.
        const contextFile = process.env.ARGUS_KNOWLEDGE_CONTEXT_FILE;
        const target = process.env.ARGUS_RULE_VERIFICATION_FILE;
        if (!contextFile) throw new Error("verify-context without ARGUS_KNOWLEDGE_CONTEXT_FILE");
        if (!target) throw new Error("verify-context without ARGUS_RULE_VERIFICATION_FILE");
        const words = rest.split(/\s+/);
        const outcome = words.shift();
        const sourcePath = words.shift();
        let check = null;
        if (words[0] && words[0].startsWith("check:")) check = words.shift().slice("check:".length);
        const note = words.join(" ");
        const context = JSON.parse(readFileSync(contextFile, "utf8"));
        const evidence =
          outcome === "unverifiable"
            ? []
            : [
                ...(check ? [{ type: "check", label: check }] : []),
                {
                  type: "source-code",
                  path: sourcePath,
                  symbol: "KobraCommentValidator.MaxLength",
                },
              ];
        writeFileAt(
          target,
          JSON.stringify({
            schemaVersion: 1,
            verifications: context.claims
              .filter((c) => c.kind === "business-rule")
              .map((c) => ({
                rule: c.ref,
                outcome,
                evidence,
                ...(outcome === "unverifiable" ? { reason: note } : { note }),
              })),
            metadata: { summary: note },
          }),
        );
        break;
      }
      case "consume-context": {
        // "The agent read the context it was given and relied on it" — the
        // one thing a discovery-downstream step must be able to do that a
        // static prompt cannot: the canonical refs are minted at the earlier
        // phase's commit, so no test could write them into a prompt in
        // advance. Every ref in the context file is declared consumed, with
        // an optional repository artifact ("-" for none).
        const file = process.env.ARGUS_KNOWLEDGE_CONTEXT_FILE;
        const target = process.env.ARGUS_KNOWLEDGE_DELTA_FILE;
        if (!file) throw new Error("consume-context without ARGUS_KNOWLEDGE_CONTEXT_FILE");
        if (!target) throw new Error("consume-context without ARGUS_KNOWLEDGE_DELTA_FILE");
        const context = JSON.parse(readFileSync(file, "utf8"));
        const artifact = rest.trim();
        writeFileAt(
          target,
          JSON.stringify({
            schemaVersion: 1,
            consumed: context.claims.map((c) => c.ref),
            ...(artifact && artifact !== "-"
              ? { artifacts: [{ location: "repository", path: artifact }] }
              : {}),
          }),
        );
        break;
      }
      case "read-context": {
        const file = process.env.ARGUS_KNOWLEDGE_CONTEXT_FILE;
        const dir = process.env.ARGUS_ARTIFACT_DIR;
        if (!file) throw new Error("read-context without ARGUS_KNOWLEDGE_CONTEXT_FILE");
        if (!dir) throw new Error("read-context without ARGUS_ARTIFACT_DIR");
        writeFileAt(path.join(dir, rest), readFileSync(file, "utf8"));
        break;
      }
      case "sleep":
        await delay(Number(rest) || 0);
        break;
      case "exit":
        state.exitCode = Number(rest) || 0;
        break;
      case "outcome": {
        const cut = rest.indexOf(" ");
        state.outcome = cut === -1 ? rest : rest.slice(0, cut);
        state.reason = cut === -1 ? "" : rest.slice(cut + 1);
        break;
      }
      case "no-signal":
        state.signal = false;
        break;
      case "fail-first": {
        if (!existsSync(rest)) {
          writeFileAt(rest, "1");
          state.exitCode = 1;
          state.signal = false;
          state.crashed = true;
          return state; // a transient crash: nothing else in this run happens
        }
        break;
      }
      default:
        throw new Error(`unknown FAKE directive: ${name}`);
    }
  }
  return state;
}

/** The stream-json transcript, exactly as the tailer and the envelope parser
 *  expect to read it back out of the run's log. */
function printTranscript(sessionId, finalMessage, crashed) {
  const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  say({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: process.cwd(),
    model: "fake-agent",
    tools: [],
  });
  if (crashed) {
    process.stderr.write("[fake-agent] simulated transient crash\n");
    return;
  }
  say({ type: "assistant", message: { content: [{ type: "text", text: finalMessage }] } });
  say({
    type: "result",
    subtype: "success",
    is_error: false,
    result: finalMessage,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    session_id: sessionId,
  });
}

/** The Stop hook command Claude Code would run: the one registered in the
 *  invocation's `--settings` file, else the repo hook directly. */
function stopHookCommand() {
  const settings = flagValue("--settings");
  if (settings) {
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    const command = parsed?.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    if (typeof command === "string" && command.trim()) return command;
  }
  return `node "${REPO_HOOK.replace(/\\/g, "/")}"`;
}

function fireStopHook(sessionId, finalMessage) {
  spawnSync(stopHookCommand(), {
    shell: true,
    input: JSON.stringify({ session_id: sessionId, last_assistant_message: finalMessage }),
    env: process.env,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

async function main() {
  const prompt = await readStdin();
  recordSeen(prompt);
  const state = await execute(prompt);
  const sessionId = flagValue("--session-id") ?? "fake-session";
  const outcomeLine = `ARGUS_OUTCOME: ${state.outcome}${state.reason ? ` ${state.reason}` : ""}`;
  const finalMessage = `Fake agent finished its work.\n${outcomeLine}`;
  printTranscript(sessionId, finalMessage, state.crashed);
  if (state.signal) fireStopHook(sessionId, finalMessage);
  process.exit(state.exitCode);
}

main().catch((error) => {
  process.stderr.write(`[fake-agent] internal error: ${error?.stack || error}\n`);
  process.exit(2);
});
