import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepDrawer, type StepSelection } from "./StepDrawer";
import type { StepPill } from "../ds";

function step(over: Partial<StepPill> = {}): StepPill {
  return {
    name: "Write the changelog entry",
    runId: "run_0003",
    status: "done",
    tokens: 31_200,
    costUsd: 0.42,
    model: "opus",
    startedAt: "2026-07-07T10:00:00.000Z",
    durationMs: 61_000,
    currentActivity: null,
    ...over,
  } as StepPill;
}

function selection(over: Partial<StepSelection> = {}): StepSelection {
  return {
    step: step(),
    pipelineName: "Release train",
    phaseName: "Draft release notes",
    reason: null,
    ...over,
  };
}

/** Answers `GET /api/runs/:id` the way the server does: the record and its
 *  log tail side by side, `{ run, log }`. */
function stubRun(body: Record<string, unknown>) {
  const { log, ...run } = body;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ run, log }) } as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StepDrawer", () => {
  it("renders nothing without a selection", () => {
    const { container } = render(<StepDrawer selection={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens as a modal dialog titled by the step, subtitled by its place", async () => {
    stubRun({ id: "run_0003", log: "" });
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: "Write the changelog entry" })).toBeInTheDocument();
    expect(screen.getByText("Release train · Draft release notes")).toBeInTheDocument();
  });

  it("describes a completion as the agent's report, never as verification", async () => {
    stubRun({ id: "run_0003", log: "" });
    const base = { signal: "completed", source: "signal", at: "2026-07-07T10:01:00.000Z" } as const;
    const { rerender } = render(
      <StepDrawer
        selection={selection({
          step: step({
            completion: { ...base, policy: "required", marker: "succeeded", verdict: "accepted" },
          }),
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("agent reported succeeded — accepted")).toBeInTheDocument();
    rerender(
      <StepDrawer
        selection={selection({
          step: step({
            completion: { ...base, policy: "lenient", marker: "missing", verdict: "accepted" },
          }),
        })}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText("no outcome marker — accepted under the lenient policy"),
    ).toBeInTheDocument();
    rerender(
      <StepDrawer
        selection={selection({
          step: step({
            completion: {
              ...base,
              policy: "required",
              marker: "missing",
              verdict: "refused",
              reason: "completion refused as unverified",
              hook: { version: 2, marker: "succeeded", agrees: false },
            },
          }),
        })}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText("no outcome marker — completion refused; hook reported succeeded"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/verified/)).toBeNull();
  });

  it("shows the run's cost, tokens, duration and model", async () => {
    stubRun({ id: "run_0003", log: "" });
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    expect(screen.getByText("run_0003")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("31.2k")).toBeInTheDocument();
    expect(screen.getByText("$0.42")).toBeInTheDocument();
    expect(screen.getByText("1m 1s")).toBeInTheDocument();
  });

  it("shows the failure reason for a failed step", async () => {
    stubRun({ id: "run_0003", log: "" });
    render(
      <StepDrawer
        selection={selection({
          step: step({ status: "failed" }),
          reason: "exit code 1 from npm audit",
        })}
        onClose={vi.fn()}
      />,
    );
    // Written by the server as a clause; set in sentence case here.
    expect(screen.getByText("Exit code 1 from npm audit")).toBeInTheDocument();
  });

  it("tells a failure once: a sentence, not the protocol, and the agent's fuller words in its place", async () => {
    stubRun({
      id: "run_0003",
      log: "",
      resultSummary:
        "Could not reach the advisory database (ETIMEDOUT) after 3 retries.\nARGUS_OUTCOME: failed could not reach advisory database (ETIMEDOUT)",
    });
    render(
      <StepDrawer
        selection={selection({
          step: step({ status: "failed" }),
          reason: "failed: could not reach advisory database (ETIMEDOUT)",
        })}
        onClose={vi.fn()}
      />,
    );
    // Before the run arrives: the reason, without the "failed:" the pill says.
    expect(screen.getByText("Could not reach advisory database (ETIMEDOUT)")).toBeInTheDocument();
    // After: the agent's own sentence says it, once, where the reason was.
    expect(
      await screen.findByText("Could not reach the advisory database (ETIMEDOUT) after 3 retries."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/reach advisory database/)).toBeNull();
    expect(screen.queryByText(/failed:/)).toBeNull();
  });

  it("words the log's envelope as the process's, without the figures shown above it", async () => {
    stubRun({
      id: "run_0003",
      exitCode: 0,
      log: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 61_000,
        num_turns: 4,
        total_cost_usd: 0.42,
        usage: { input_tokens: 115_620, output_tokens: 25_380 },
      }),
    });
    render(
      <StepDrawer
        selection={selection({ step: step({ status: "failed", tokens: null }) })}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText("Process")).toBeInTheDocument();
    expect(screen.getByText(/^exited cleanly/)).toBeInTheDocument();
    // The step failed all the same, and the log says why the two disagree.
    expect(screen.getByText(/failed its outcome check/)).toBeInTheDocument();
    // Cost and duration are in the readout already; tokens are not, so they
    // stay, in the app's own format and the reading face.
    expect(screen.getAllByText("Cost")).toHaveLength(1);
    expect(screen.getByText("115.6k in / 25.4k out")).not.toHaveClass("font-mono");
  });

  it("says a non-zero exit as the exit code, whatever the CLI's envelope said", async () => {
    // The envelope's "success" is the CLI's verdict on its session; this
    // process exited 1, and the drawer said "exited cleanly — the run failed
    // its outcome check all the same".
    stubRun({
      id: "run_0003",
      exitCode: 1,
      log: JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 4 }),
    });
    render(
      <StepDrawer selection={selection({ step: step({ status: "failed" }) })} onClose={vi.fn()} />,
    );
    expect(await screen.findByText("exited with code 1")).toBeInTheDocument();
    expect(screen.queryByText(/exited cleanly/)).toBeNull();
    expect(screen.queryByText(/failed its outcome check/)).toBeNull();
  });

  it("shows the agent's summary without the protocol line it ends with", async () => {
    stubRun({
      id: "run_0003",
      log: "",
      resultSummary: "Drafted the changelog entry.\nARGUS_OUTCOME: succeeded",
    });
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    expect(await screen.findByText("Drafted the changelog entry.")).toBeInTheDocument();
    expect(screen.queryByText(/ARGUS_OUTCOME/)).not.toBeInTheDocument();
  });

  it("falls back to the marker's reason when the marker is all the summary has", async () => {
    stubRun({
      id: "run_0003",
      log: "",
      resultSummary: "ARGUS_OUTCOME: failed tests are red",
    });
    render(
      <StepDrawer selection={selection({ step: step({ status: "failed" }) })} onClose={vi.fn()} />,
    );
    expect(await screen.findByText("tests are red")).toBeInTheDocument();
    expect(screen.queryByText(/ARGUS_OUTCOME/)).not.toBeInTheDocument();
  });

  it("renders the run log", async () => {
    stubRun({ id: "run_0003", log: "[argus] starting\n[claude] done\n" });
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/\[argus\] starting/)).toBeInTheDocument());
  });

  it("says a step that has not started has no run yet, and fetches nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <StepDrawer
        selection={selection({ step: step({ runId: null, status: "queued" }) })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/hasn't started/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a failure to load the run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response),
    );
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("HTTP 404"));
  });

  it("links to the transcript when the run recorded one", async () => {
    stubRun({ id: "run_0003", log: "", sessionId: "sess-1", project: "-home-me-spectacle" });
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /open transcript/i })).toHaveAttribute(
        "href",
        "#/sessions/-home-me-spectacle/sess-1",
      ),
    );
  });

  it("offers Cancel only while the step is running", async () => {
    stubRun({ id: "run_0003", log: "" });
    const { unmount } = render(
      <StepDrawer selection={selection()} onClose={vi.fn()} onCancelRun={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /cancel run/i })).toBeNull();
    unmount();

    render(
      <StepDrawer
        selection={selection({ step: step({ status: "working" }) })}
        onClose={vi.fn()}
        onCancelRun={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /cancel run/i })).toBeInTheDocument();
  });

  it("reports a cancel failure instead of closing over it", async () => {
    stubRun({ id: "run_0003", log: "" });
    const user = userEvent.setup();
    const onCancelRun = vi.fn().mockRejectedValue(new Error("run already finished"));
    render(
      <StepDrawer
        selection={selection({ step: step({ status: "working" }) })}
        onClose={vi.fn()}
        onCancelRun={onCancelRun}
      />,
    );
    await user.click(screen.getByRole("button", { name: /cancel run/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("run already finished"),
    );
  });

  it("closes on Escape and on the close button", async () => {
    stubRun({ id: "run_0003", log: "" });
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<StepDrawer selection={selection()} onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps Tab inside the dialog", async () => {
    stubRun({ id: "run_0003", log: "", sessionId: "sess-1", project: "p" });
    const user = userEvent.setup();
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    // Two focusables: the close button and the transcript link. Tabbing past the
    // last must wrap to the first, not escape to the page behind.
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /open transcript/i })).toBeTruthy(),
    );
    await user.tab();
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
  });
  it("names the workspace branch, with the disposable directory as its title", async () => {
    stubRun({ id: "run_0003", log: "" });
    render(
      <StepDrawer
        selection={selection({
          step: step({
            workspace: {
              path: "/home/u/.claude/argus/worktrees/i1/shared",
              branch: "argus/i1/shared",
              base: "HEAD",
              baseHead: "abc123",
            },
          }),
        })}
        onClose={vi.fn()}
      />,
    );
    const branch = await screen.findByText("argus/i1/shared");
    expect(branch.getAttribute("title")).toBe("/home/u/.claude/argus/worktrees/i1/shared");
    expect(screen.getByText("workspace")).toBeTruthy();
  });

  it("says nothing about a workspace for a step that ran without one", async () => {
    stubRun({ id: "run_0003", log: "" });
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    // Let the run detail settle first, so this asserts on the loaded drawer.
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByText("workspace")).toBeNull();
  });

  it("names which candidate a best-of-N run was, and that it won", async () => {
    stubRun({ id: "run_0003", log: "" });
    render(
      <StepDrawer
        selection={selection({
          step: step({ candidate: { index: 1, total: 3 }, verified: true, selected: true }),
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("candidate")).toBeTruthy();
    expect(screen.getByText("c2 of 3")).toBeTruthy();
    expect(screen.getByText(/· selected/)).toBeTruthy();
  });

  it("calls a killed loser superseded rather than failed", async () => {
    stubRun({ id: "run_0003", log: "" });
    render(
      <StepDrawer
        selection={selection({
          step: step({
            status: "stopped",
            candidate: { index: 2, total: 3 },
            superseded: true,
          }),
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/superseded by the winner/)).toBeTruthy();
  });

  it("says nothing about candidates for an ordinary step", async () => {
    stubRun({ id: "run_0003", log: "" });
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByText("candidate")).toBeNull();
  });
});
