# Your first run

[Documentation index](../README.md) · [Install and start](README.md) · [Feature guides](../guides/README.md)

Launch one small task, inspect its output, and find its record. This walkthrough creates a single run; it creates no schedule and makes no request to change project files.

## Before you begin

- Complete [Install and start Argus](README.md), including your chosen CLI's authentication or local model configuration.
- Keep the Argus terminal running and the dashboard open. The production default is <http://127.0.0.1:7777>.
- Choose an existing directory on the **machine running Argus**, with a `README.md` you are comfortable giving the agent. Your Argus checkout is a convenient choice.
- Know that an agent run uses your provider account or local endpoint. Cost reporting varies by runtime; an absent dollar value does not mean a free run.

## 1. Copy the project directory

Open a terminal in the chosen directory and copy its absolute path.

**PowerShell 7:**

```powershell
(Get-Location).Path
```

**Bash:**

```bash
pwd
```

Use the actual output, such as `C:\work\Argus` or `/home/you/Argus`, in the form. Do not paste the example unchanged. Argus validates that the directory exists on its host. A path on another computer or a shell abbreviation such as `~` is unsuitable here.

## 2. Open the one-off form

Select **Scheduler → One-off**, or visit `#/schedules/oneoff` in the dashboard. **Recent one-off runs** may initially say **Nothing launched yet**.

Fill in the form:

| Field             | Value for this walkthrough                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Working directory | The absolute path you just copied                                                          |
| Name              | `First run — README summary`                                                               |
| Runtime           | The installed CLI you already tested, selected explicitly                                  |
| Model             | **Inherit CLI**; use the same working provider/model configuration as your direct CLI test |
| Effort            | **Inherit CLI**, when offered                                                              |

Selecting a different runtime clears model and effort overrides. A runtime marked **not installed** is offered for configuration purposes; choosing it does not install the CLI.

Paste this bounded prompt:

```text
Read only the README.md in the working directory. Summarize what this project
does and how a newcomer starts it, in at most five short bullet points.
If README.md is absent, report that and stop. Do not read other project files,
modify or create files, install dependencies, run tests, commit, push, or make
external requests. Finish your response with: ARGUS_FIRST_RUN_COMPLETE
```

This is an instruction to the agent. The one-off form does not set a capability profile or a hard timeout; the CLI's configured permissions still apply. For a Codex walkthrough that also restricts filesystem writes, you can start Argus with `ARGUS_CODEX_SANDBOX=read-only` using the shell-specific environment syntax in [Install and start](README.md#optional-choose-another-port-or-set-environment-variables). Runtime permissions and pipeline capability profiles are covered in [Runtime reference](../reference/runtimes.md) and [Pipelines](../guides/pipelines.md).

## 3. Launch once

Select **▶ Launch** once. The button becomes available after the prompt and working directory are filled. If validation fails, the form shows an error; correct it before retrying.

**Expected result:** a new entry appears in **Recent one-off runs** with your chosen name and a running status. The form keeps the directory, runtime, model, and effort, while clearing the prompt and name. This confirms that Argus accepted a launch; it does not yet confirm the agent completed it.

Argus runs the CLI headlessly in your chosen directory. There is no recurring trigger and no schedule definition to disable afterwards.

## 4. Read the run and its result

Expand the run row by selecting it or its arrow. Inspect the log while it runs. The expanded log refreshes every three seconds while running; a runtime may emit little or no visible text until it produces its final result. One-off runs use the batch run path, so do not expect the same continuous tool-event stream as a pipeline step.

**Expected result when successful:** the run changes to a success state and the expanded row shows a short README summary ending with `ARGUS_FIRST_RUN_COMPLETE`. Duration and reported tokens/cost appear when available. A marker alone is not evidence of correct content: read the summary and compare it with the README.

If the run fails, the row shows the failure reason or log. Keep that exact message for diagnosis. Common causes are a missing CLI, expired provider credentials, an unavailable model, or an incorrect working directory. See the troubleshooting table below before launching again.

Select **▶ replay** to open the **Flight Recorder** for this run. If the runtime provides a readable transcript and Argus has learned its session ID, the row also offers a **transcript** link. OpenCode's transcripts are stored in its private database and are not readable in Argus Sessions; the run's own result and log remain the useful starting point.

## 5. Find the same run elsewhere

- **Chronicle:** find the **One-off runs** lane and your run's start/finish record.
- **Scheduler → One-off:** the recent list keeps the run available for expansion and **Reuse**.
- **Budget / Ledger:** review reported spend; Codex's supported-model dollar values are estimates, and some runtimes/models do not report a dollar value.
- **Issues:** a failed run can appear grouped with failures of the same cause.

One-off runs have no expected recurring slot, so they do not create missing-run monitor expectations. Records use `scheduleId: "oneoff"`; their JSON records and log files live beneath `~/.claude/argus/runs/` by default. Argus retains a bounded recent window. Use [Budget and history](../guides/budget-and-history.md) and [Operations](../reference/operations.md) for retention and longer history.

## Cancel a running task

Select **Cancel** on its row while the run is running. Argus requests process termination and marks the run cancelled. If it finished before you clicked, inspect the terminal result instead. Cancellation stops further work; it does not undo changes an agent already made.

For this first run, use cancellation if the agent expands beyond the requested README summary or appears stuck. Do not launch repeated copies while diagnosing the first one. Closing the browser tab does not cancel a run.

## Troubleshooting

| Symptom                                          | What to check                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Launch button disabled                           | Both prompt and working directory must be non-empty                                                                                       |
| `cwd does not exist`                             | Paste a real absolute directory from the Argus host, with no surrounding quotes                                                           |
| CLI missing or spawn failure                     | Test the selected CLI's version command in the terminal used to start Argus; verify its executable override and PATH                      |
| Login, credential, provider, or model error      | Run a small prompt directly with that CLI as the same user; fix its authentication/configuration before retrying                          |
| Empty log while running                          | Wait for output; batch runs can be quiet. If stalled, cancel and inspect the exact error/log                                              |
| No transcript link                               | The session ID may not be available yet, or the selected runtime may not support readable Sessions transcripts                            |
| Result lacks the marker or reads unrelated files | Inspect the result and recorder before reusing the prompt; runtime success means the run completed, not that every instruction was obeyed |

## Continue with the features you need

- [Scheduling](../guides/scheduling.md): turn a task into a recurring schedule, use **Run now**, or reuse a one-off prompt.
- [Pipelines](../guides/pipelines.md): split work into phases and steps, review gates, and approve, revise, or abort. Sign in with a root or approved member account first.
- [Monitoring](../guides/monitoring.md): understand the Command Center, Briefing, Chronicle, and Flight Recorder.
- [Health and quality](../guides/health-and-quality.md): monitor expected work, investigate failures, and inspect quality analysis.
- [Feature guide index](../guides/README.md): find every dashboard capability.
- [Agent guide](../AGENT-GUIDE.md): use the documentation and interfaces from an AI agent.

Implementation references: [launch validation](../../server/src/sources/launch.ts), [launch form](../../web/src/views/Launch.tsx), [run tracking](../../server/src/scheduler.ts), and [run rows](../../web/src/views/RunRow.tsx). Complete this walkthrough on your own installation to verify your CLI, credentials, and model together.
