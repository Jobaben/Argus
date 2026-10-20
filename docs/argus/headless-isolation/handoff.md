# Handoff: a Claude setup folder per pipeline

**Repo:** `C:\GIT\argus`. The remote `origin` is GitHub (`Jobaben/Argus`). Never use `gh`.
**Updated:** 2026-10-20, second session. Argus support is built and tested on the branch `claude/busy-keller-i8oz71`, open as PR #94, not merged. That session ran in a Linux cloud container, so everything that needs the operator's Windows machine or a real CLI is still open: the probes, the done gate on Windows and the live acceptance. Update this file in place as the work moves.
**Read with:** the [reliability handoff](../reliability/handoff.md) for the done gate, the test baseline and the Windows environment gotchas, and [HARNESS.md §3b](../../HARNESS.md#3b-a-claude-setup-folder-per-pipeline-claudeconfigdir) for what the field does now.

## Where things stand

| Item                    | State                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Approach                | Decided with the user on 2026-10-20: every pipeline gets its own Claude setup folder, on the operator's one account.            |
| Manual setup            | ✅ Verified on Claude Code 2.1.304 (evidence below).                                                                            |
| First pipeline using it | ✅ The local "Agentic Delivery Loop" (`570887c5`), on `env.set.CLAUDE_CONFIG_DIR` since 2026-10-20. Not moved to the field yet. |
| Decisions D1–D4         | ✅ Taken by the user on 2026-10-20, all four as recommended (below).                                                            |
| Argus support           | 🔵 Built on `claude/busy-keller-i8oz71`, tested on Linux. Ready for verification; not merged.                                   |
| Live acceptance         | ⬜ Needs the Windows machine and a real CLI.                                                                                    |

## Decisions (the user, 2026-10-20)

- **D1, field name and level:** a pipeline-level `claudeConfigDir`, nothing per phase.
- **D2, protection and exclusion:** Argus adds them itself, for every Claude step of a pipeline with a folder.
- **D3, finding transcripts:** the folder is recorded on each run (`Run.claudeConfigDir`); the current definitions are never scanned.
- **D4, scope:** pipelines only. Schedules, Launch-tab runs and analysis passes keep the operator's setup.

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

Point each pipeline at its own Claude config folder with `CLAUDE_CONFIG_DIR`. For the CLI, that folder replaces `~/.claude` completely, so nothing has to be subtracted. HARNESS.md §3b has the folder's layout, how to sign it in (`claude setup-token`, the token in the folder's `settings.json`), and why neither a user-wide variable nor Argus's own environment may carry the token.

## What was built

On `claude/busy-keller-i8oz71`. Every item has tests beside the existing ones.

1. **The contract field.** `PipelineDefinition.claudeConfigDir` and `PipelineInput.claudeConfigDir` (`contracts/src/pipelines.ts`), `Run.claudeConfigDir` (`contracts/src/schedules.ts`) and `AgentInvocationRecord.claudeConfigDir`. All optional and additive.
2. **Validation** (`sources/pipelines.ts`, `validateClaudeConfigDir` and `assertClaudeConfigDirFits`). The folder must be an absolute path to an existing directory that a rule can name, and is stored resolved. It is refused when it:
   - is or contains the operator's Claude home (`claudeHome()` or `~/.claude`);
   - contains Argus's work root;
   - contains a phase `cwd` or an `additionalDirectories` entry;
   - sits beside a `capabilities.env.set.CLAUDE_CONFIG_DIR` at any level.

   `updatePipeline` re-checks the merged definition, so a `PATCH` that only sends phases can't sneak the conflict in. `claudeConfigDir: null` in a `PATCH` clears the field. It is also in `EXECUTION_KEYS` (`app.ts`): changing it under a live instance is a `409` without `?force=1`.

3. **Launch.**
   - `claudeConfigDirFor` (`harness/invocation.ts`) answers "which folder" for Claude steps only. The engine records the same answer on the run (`engine/launch.ts`).
   - `prepareInvocation` hands the runtime a `ClaudeConfigRequest` (`runtimes/types.ts`), with or without a capability profile.
   - A Codex, OpenCode or Qwen step gets a recorded, never-blocking note: `"<Runtime> does not load a Claude config folder: claudeConfigDir does not apply to this step"`.
4. **The Claude mapping** (`runtimes/claude.ts`).
   - The child environment gets `CLAUDE_CONFIG_DIR`.
   - `configFolderRules` adds `Read(//<f>/settings.json)`, `Read(//<f>/.credentials.json)` and `Edit(//<f>/**)` to the one `--disallowedTools` flag. A repeated flag's behaviour isn't documented, so it is never repeated.
   - `claudeSettingsFile` writes the per-run `settings.json` with Argus's hooks plus `claudeMdExcludes: [operatorClaudeMd()]` (`claudeHome.ts`: `<os.homedir()>/.claude/CLAUDE.md`, forward slashes).
   - `buildClaudeConfigOnly` covers a step without a profile. Its hooks are registered too, because the installed copy lives in the home the folder replaces.
   - A plan with no folder is byte-identical to before, which the existing legacy tests pin.
5. **Transcripts.**
   - `sources/transcriptRoots.ts` `claudeProjectRoots()` returns the operator's `projects/` plus `<folder>/projects` for every folder a recorded run names.
   - The session list, detail, tail, raw lines (Flight Recorder), search (`search.ts`) and projects (`projects.ts`) all scan every root.
   - `projects.ts`'s cache key now includes the roots; it was a fixed `"projects"` key before.
   - `watchSessions` (`watch.ts`) widens to new roots every 15 s.
6. **Docs.** HARNESS.md §3b, plus the hook and precedence notes in §3 and the record note in §8. API.md: the field row, `Run.claudeConfigDir`, the invocation record and the `PUT` execution-field list, which was already missing `workspace` and `memory`. Also DATA-MODEL.md, `reference/configuration.md`, the pipelines guide (a new "Give the pipeline its own Claude setup" section and recipe row), the guides index, and CHANGELOG `[Unreleased]`.

### Choices made beyond D1–D4 (worth a look in review)

- **`.credentials.json` is denied too.** A folder signed in with `/login` instead of a token would keep its OAuth tokens there, as the CLI's own `~/.claude/.credentials.json` does on Windows (inferred, not probed). The rule is harmless when the file doesn't exist.
- **Hooks without a profile.** Without them, a no-profile step on a folder would never signal: the Setup-installed hook is in `~/.claude/settings.json`, which the folder replaces.
- **Other runtimes never block.** The field is pipeline-level only, so a Codex phase can't opt out of it. Refusing its launch would make mixed-runtime pipelines impossible.
- **The exclusion names `~/.claude/CLAUDE.md` only,** from `os.homedir()`, as the first session recommended. An operator whose own config is relocated with `CLAUDE_CONFIG_DIR` isn't covered. The parent walk only finds a relocated file that sits in a `.claude` folder above the working directory.
- **Pruned runs drop their folder transcripts from Argus** (D3's trade-off). The files stay in the folder.

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

From the docs (code.claude.com, read 2026-10-20), which back the implementation's assumptions:

- `claudeMdExcludes` arrays merge across settings layers (memory page: "Arrays merge across layers"). `--settings` is a layer above user, project and local, and "can set any key your user settings file can set". The flag layer isn't named for `claudeMdExcludes` itself.
- Repeating `--allowedTools` or `--disallowedTools` is not documented, hence one flag.
- `CLAUDE_CONFIG_DIR` moves "all settings, session history, and plugins". Where `.claude.json` lives under it is not documented.

**The second session's test results (Linux, Node 22):**

- **Baseline on the unmodified tree:** 3,298 tests, 3,293 pass, 4 skipped, 1 fail. The failure is real and predates this work: `app.test.ts` "GET /api/pipelines/:id/reliability derives from this pipeline's settled instances". Its `settledInstance` fixture pins its timestamps to 2026-09-18 and the route counts 30 days back from now, so it has failed on `main` since 2026-10-18, in CI too (both jobs), which also stopped CI before its coverage, build and budget steps. A separate commit on this branch dates the fixture an hour before now; PR #94 asked for green CI and the branch is the only one this session may push to. Cherry-pick it to `main` if the PR waits.
- **On the branch:** see "Done gate" below.

## Done gate (Linux, second session)

Run on `claude/busy-keller-i8oz71` before the commit:

- typecheck, lint, `prettier --check --end-of-line auto .`, `check-contracts-runtime` and `git diff --check`: all pass.
- `npm -w server run test:timeboxed`: 3,321 tests, 3,315 pass, 4 skipped, 2 fail.
  - One is the date-pinned `app.test.ts` baseline above.
  - The other is `cli/release.test.ts` "release: a build whose version.js disagrees fails the smoke check". It passes alone three times out of three and passed in the coverage run. It is load-only, like the `release --use` failure the reliability plan records, and nothing it imports changed.
- `npm -w server run test:coverage`: 3,321 tests, 3,316 pass, 4 skipped, 1 fail (the date-pinned baseline). No threshold failed: 78.86 % lines, 70.09 % branches, 72.75 % functions.
- `npm run build`, `node bin/argus.mjs --help` and `check-bundle-size` pass. The bundle is 121.9 kB of 122 kB, **0.1 kB to spare** (0.2 kB on 2026-10-13). The contract additions are types only, so this is `main`'s bundle.
- `npm -w web run test`: 125 files, 1,231 tests, all pass. The reliability handoff's `sessionList` failure depends on the machine's locale, so it didn't show here.

Web code is untouched: only the contract types changed, and the web typecheck passes. Nothing was run on Windows.

## Not verified yet

Probe these one at a time: real-CLI probes race on `.claude.json`.

- **From the first session:**
  - the repo's `.mcp.json` loading headless, given project-server approval;
  - claude.ai connectors under a token sign-in, which has no account details;
  - the repo's `.claude/agents` and `.claude/commands`;
  - a nested `sub/CLAUDE.md` loading on demand;
  - the PR attribution setting;
  - a full pipeline instance on the setup.
- **New with the field:**
  - `claudeMdExcludes` arriving through the per-run `--settings` file, rather than the folder's own `settings.json`. The pipeline already on the folder excludes the file in its own settings, so moving it to the field can't regress whichever way this lands.
  - the three deny rules together in one flag, and the `.credentials.json` rule (only the `settings.json` form was probed);
  - a step **without** a capability profile on a folder: Argus's hooks through `--settings` under `CLAUDE_CONFIG_DIR`. Profile steps already run this way on the current pipeline.
  - the session watcher picking up a new folder (no automated test; the repo has none for `watch.ts`);
  - the full done gate on Windows. CI's `windows` job ran the server suite on PR #94's first push: every new test passed, and only the date-pinned baseline failed. The web tests and the checks after them did not run there.
- **Related, for WS13:** where `.claude.json` lives under `CLAUDE_CONFIG_DIR`. If it moves into the folder, a pipeline's steps race only among themselves, not with the operator's sessions.

## Next session

1. Review PR #94 (`claude/busy-keller-i8oz71`) and merge it if it holds up; that's the user's call. Its commits carry no attribution lines. They are commits and not staged changes because the cloud session would have lost uncommitted work.
2. Run the done gate on Windows, using the reliability handoff's commands and gotchas. Compare against that baseline. The date-pinned `app.test.ts` failure above is fixed on this branch.
3. Probe the unverified rows, one at a time. Use a scratch folder signed in with the existing token, and a scratch repo with marker files, `.claude/agents`, `.claude/commands` and a `.mcp.json`.
4. **Move "Agentic Delivery Loop" onto the field**, in one save, because the validation refuses the field beside `env.set.CLAUDE_CONFIG_DIR`. Send `claudeConfigDir` together with the `capabilities` (or phases) that no longer carry the `env.set` entry. The per-phase `Read`/`Edit` denies are now redundant, and harmless if kept. Drop them in the same save if wanted.
5. **Live acceptance:** a pipeline instance on the folder. Check that:
   - the step's transcript opens in Argus;
   - the operator's `CLAUDE.md` stays out;
   - the folder's and the repo's instructions reach a subagent;
   - `GET /api/runs/:id/invocation` shows `claudeConfigDir`, the three deny rules and the per-run `settings.json` with `claudeMdExcludes`.
6. Any release is the user's call. The entry sits under `[Unreleased]`.

## The pipeline already on it

"Agentic Delivery Loop" (`570887c5`). Its folder is `~/.claude-pipelines/delivery-loop/`:

- **`CLAUDE.md`** is the pipeline's working model, copied from its context pack. The pack's `WORKING-MODEL.md` copy is now unused.
- **`settings.json`** holds the token, `claudeMdExcludes`, `attribution` and `autoMemoryEnabled: false`.

**The pipeline definition, since 2026-10-20:**

- `env.set.CLAUDE_CONFIG_DIR` points at the folder.
- Every phase denies `Read` on the folder's `settings.json` and `Edit` on the folder.
- The old workaround is gone: `settingSources: ["project"]`, the `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` variables, `mcpServers: {}` and the prompt lines that told agents to read the CLAUDE.md files.

**Once the branch is merged:** move the folder from `env.set` to `claudeConfigDir` (step 4 above). The per-phase rules are then automatic (D2). Its runs since 2026-10-20 recorded no folder, so their transcripts stay invisible in Argus. Only runs launched on the field are found.
