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

function stubRun(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as Response),
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
          reason: "npm audit: 3 critical vulnerabilities",
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("npm audit: 3 critical vulnerabilities")).toBeInTheDocument();
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
    stubRun({ id: "run_0003", log: "", sessionId: "sess-1", project: "-home-me-starling" });
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /open transcript/i })).toHaveAttribute(
        "href",
        "#/sessions/-home-me-starling/sess-1",
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Esc" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Esc" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps Tab inside the dialog", async () => {
    stubRun({ id: "run_0003", log: "", sessionId: "sess-1", project: "p" });
    const user = userEvent.setup();
    render(<StepDrawer selection={selection()} onClose={vi.fn()} />);
    const close = screen.getByRole("button", { name: "Esc" });
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
});
