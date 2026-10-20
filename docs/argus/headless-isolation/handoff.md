# Handoff: a Claude setup folder per pipeline

**Repo:** `C:\GIT\argus`. The remote `origin` is GitHub (`Jobaben/Argus`). Never use `gh`.
**Updated:** 2026-10-20. The approach works without any Argus change: one pipeline already runs on it, through `env.set`. This file covers what Argus needs to support it properly. Update it in place as the work moves.
**Read with:** the [reliability handoff](../reliability/handoff.md) for the done gate, the test baseline and the Windows environment gotchas, and [HARNESS.md §3](../../HARNESS.md#3-capability-profiles) for capability profiles.

## Where things stand

| Item                    | State                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Approach                | Decided with the user on 2026-10-20: every pipeline gets its own Claude setup folder, on the operator's one account. |
| Manual setup            | ✅ Verified on Claude Code 2.1.304 (evidence below).                                                                 |
| First pipeline using it | ✅ The local "Agentic Delivery Loop" (`570887c5`), switched on 2026-10-20 through `env.set.CLAUDE_CONFIG_DIR`.       |
| Argus support           | ⬜ Not started. The four gaps are below.                                                                             |

## The problem

Every Argus agent runs `claude -p` on the operator's machine, signed in as the operator. By default it loads the operator's whole personal setup from `~/.claude`:

- `CLAUDE.md`;
- settings, including hooks, permission grants and `defaultMode`;
- skills, agents and commands;
- user-scope MCP servers;
- auto-memory.

Two things follow:

- a pipeline's agents follow rules written for the operator's interactive work;
- the operator's interactive sessions and the pipelines can't be set up independently.

## The approach

Point each pipeline at its own Claude config folder with `CLAUDE_CONFIG_DIR`. For the CLI, that folder replaces `~/.claude` completely, so nothing has to be subtracted:

| In the folder                     | Role                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                       | The pipeline's own instructions, loaded as the "global" CLAUDE.md by every agent and subagent. |
| `settings.json`                   | Sign-in token, attribution, auto-memory, permissions and hooks for this pipeline only.         |
| `skills/`, `agents/`, `commands/` | The pipeline's own, where it needs any.                                                        |
| `projects/`                       | Written by the CLI: the session logs of every run, including subagent logs.                    |

The repository's own `CLAUDE.md` files, their `@` imports and its `.claude/` content still load on top, exactly as for anyone who opens the repo.

**Sign-in, one account.** A new config folder starts logged out. `claude setup-token` creates a long-lived token for the operator's subscription account, and the CLI signs in with it when the folder's `settings.json` sets it:

```json
{
  "env": { "CLAUDE_CODE_OAUTH_TOKEN": "<token>" },
  "claudeMdExcludes": ["C:/Users/<you>/.claude/CLAUDE.md"],
  "attribution": { "commit": "", "pr": "" },
  "autoMemoryEnabled": false
}
```

- **Where the token lives.** The operator decided to keep it in this file. It is plain text, as the CLI's own `~/.claude/.credentials.json` already is on Windows. Each pipeline denies its agents `Read` on the file.
- **Don't use a global user environment variable.** `CLAUDE_CODE_OAUTH_TOKEN` overrides the stored login everywhere, including the operator's interactive sessions.
- **Don't put it in Argus's environment either.** Every agent that inherits Argus's environment would switch to it.
- **Why `claudeMdExcludes`.** CLAUDE.md discovery walks every parent directory of the working directory and also reads `<parent>/.claude/CLAUDE.md`, past the git root. Argus worktrees live under `~/.claude-argus/worktrees/`, inside the home folder, so without the exclusion every step would still load `~/.claude/CLAUDE.md` as a "project" file.

## Evidence

Claude Code 2.1.304 on Windows 11, 2026-10-20, real token unless a row says otherwise. Each probe used marker lines in the files and asked a Haiku session to list the markers in its context without reading any file.

| Finding                                                                                                                                                                 | Setup                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| The CLI signs in with the token from the folder's `settings.json` (`claude auth status`: `oauth_token`).                                                                | The folder alone                                  |
| The folder's `CLAUDE.md`, the repo's `CLAUDE.md` and its `@AGENTS.md` import all load. A general-purpose subagent reported all three.                                   | Repo outside the home folder                      |
| From a repo under the home folder, `~/.claude/CLAUDE.md` loads through the parent walk. With `claudeMdExcludes` it doesn't, and the repo's markers still load.          | Repo under the home folder                        |
| A headless commit has no `Co-Authored-By` trailer with `attribution.commit: ""`.                                                                                        | `acceptEdits`, `git add` and `git commit` allowed |
| No persistent memory directory with `autoMemoryEnabled: false`.                                                                                                         | The folder alone                                  |
| `Read` of the folder's `settings.json` is refused under a `Read(//c/Users/<you>/.claude-pipelines/<name>/settings.json)` deny rule.                                     | `--disallowedTools`                               |
| Session logs, including subagent logs, land in `<folder>/projects/`.                                                                                                    | The folder alone                                  |
| `CLAUDE_CODE_OAUTH_TOKEN` in the environment overrides the stored login even with the default `~/.claude`, and `auth status` then shows no email, organisation or plan. | Dummy token, 2026-10-20                           |
| `--bare` would load nothing implicitly, but it signs in only with an API key, never OAuth, so it is not an option for a subscription account.                           | `claude --help`                                   |

**Not verified yet:**

- the repo's `.mcp.json` loading headless, given project-server approval;
- claude.ai connectors under a token sign-in, which has no account details;
- the repo's `.claude/agents` and `.claude/commands`;
- a nested `sub/CLAUDE.md` loading on demand;
- the PR attribution setting;
- a full pipeline instance on the setup.

## What Argus needs

1. **Session logs.** Argus finds transcripts only under `claudeHome()/projects`:
   - the session view, `server/src/sources/sessions.ts:370`;
   - search, `search.ts:81`;
   - projects, `projects.ts:86`;
   - the file watcher, `watch.ts:53`.

   Runs in a pipeline folder don't appear in any of them, and a step's transcript link doesn't resolve. Live activity is unaffected, because it comes from Argus's own stream log. Argus has to read `<folder>/projects` for every folder in use.

2. **A first-class field.** Today the folder rides on `env.set.CLAUDE_CONFIG_DIR`. Capabilities merge by top-level key (`resolveCapabilities`, `harness/invocation.ts:52`), so a phase that declares its own `env` silently drops the folder. A dedicated field fixes that, for example a pipeline-level `claudeConfigDir`. Validate that it exists, that it is absolute, and that it is not the operator's own Claude home.
3. **Built-in protection.** When a pipeline names a folder, Argus could add two rules to every invocation itself:
   - the `Read` deny on `<folder>/settings.json`;
   - an `Edit` deny on the folder.

   That way each pipeline doesn't have to repeat them in every phase's `tools.deny`.

4. **The parent walk.** Argus could also write `claudeMdExcludes` for the operator's `CLAUDE.md` into its per-run `--settings` file, so a folder without the line can't leak it. The alternative is to move the default work root out of the home folder (`argusWorkRoot`, `claudeHome.ts`).
   - That per-run file exists only for steps with a capability profile (`runtimes/claude.ts:255-276`).
   - Name the operator file the child CLI would otherwise read. `claudeHome()` prefers `ARGUS_CLAUDE_HOME`, which tests repoint.

## Decisions needed

- **D1, field name and level.** Recommendation: pipeline level only. A folder per phase complicates the transcript lookup and has no use case yet.
- **D2, gaps 3 and 4.** Should Argus add the protection rules and the exclusion itself, or document them as the folder author's job? Recommendation: Argus adds them, because they cost nothing and the failure modes are silent.
- **D3, finding transcripts.** Should Argus scan the folders named by current pipeline definitions, or record each run's folder on its run record? Recommendation: record it on the run, so deleted or edited pipelines keep their history.
- **D4, scope.** Pipelines only (recommended), or schedules too? Schedules and analysis runs launch without capabilities today (`scheduler.ts:195`, `sources/analysis.ts:282`).

## Next session

1. Take D1–D4 to the user.
2. Probe the unverified rows, one at a time, because real-CLI probes race on `.claude.json`. Use a scratch folder signed in with the existing token, and a scratch repo with marker files, `.claude/agents`, `.claude/commands` and a `.mcp.json`.
3. Implement the following on a feature branch:
   - the contract field (`contracts/src/pipelines.ts`);
   - validation (`server/src/sources/pipelines.ts`);
   - the Claude mapping, which sets the child's `CLAUDE_CONFIG_DIR` (`runtimes/claude.ts`);
   - the transcript lookup;
   - the protection rules;
   - tests next to the existing ones in `runtimes/claude.test.ts`, `harness/invocation.test.ts` and `sources/pipelinesHarness.test.ts`.

   Other runtimes report the field as a limitation, through `unsupportedCapabilities` in `runtimes/types.ts`.

4. Update HARNESS.md §3, API.md (the capability table), the pipelines guide and the CHANGELOG under `[Unreleased]`.
5. Run the done gate from the reliability handoff.
6. **Live acceptance:** a pipeline instance on a folder. The step's transcript must open in Argus, the operator's `CLAUDE.md` must stay out, and the folder's and repo's instructions must reach a subagent.
7. Stage, stop and report. Don't commit, merge or push unless the user asks, and add no attribution lines.

## The pipeline already on it

"Agentic Delivery Loop" (`570887c5`). Its folder is `~/.claude-pipelines/delivery-loop/`:

- **`CLAUDE.md`** is the pipeline's working model, copied from its context pack. The pack's `WORKING-MODEL.md` copy is now unused.
- **`settings.json`** holds the token, `claudeMdExcludes`, `attribution` and `autoMemoryEnabled: false`.

**The pipeline definition, since 2026-10-20:**

- `env.set.CLAUDE_CONFIG_DIR` points at the folder.
- Every phase denies `Read` on the folder's `settings.json` and `Edit` on the folder.
- The old workaround is gone: `settingSources: ["project"]`, the `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` variables, `mcpServers: {}` and the prompt lines that told agents to read the CLAUDE.md files.

**Once the field exists:** move the folder from `env.set` to the field, and drop the per-phase rules if D2 makes them automatic.
