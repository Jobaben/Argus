import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { PhaseArtifactContent, PhaseReview } from "../types";
import { GateDrawer, type GateSelection } from "./GateDrawer";

// The drawer's read side, canned per test. The artifact content mock answers
// by path so selecting a file changes what the viewer shows.
const mockReview: { review: PhaseReview | null; loading: boolean; error: string | null } = {
  review: null,
  loading: false,
  error: null,
};
const mockContent = new Map<string, PhaseArtifactContent>();
const mockContentError: { error: string | null } = { error: null };
vi.mock("../useGateReview", () => ({
  useGateReview: (instanceId: string | null, phaseId: string | null) =>
    instanceId && phaseId ? mockReview : { review: null, loading: false, error: null },
  useArtifactContent: (_i: string | null, _p: string | null, path: string | null) =>
    mockContentError.error
      ? { content: null, loading: false, error: mockContentError.error }
      : { content: path ? (mockContent.get(path) ?? null) : null, loading: false, error: null },
}));

const selection: GateSelection = {
  instanceId: "i1",
  phaseId: "draft",
  pipelineName: "Reports",
};

function review(over: Partial<PhaseReview> = {}): PhaseReview {
  return {
    instanceId: "i1",
    phaseId: "draft",
    phaseName: "Draft",
    pipelineName: "Reports",
    status: "awaiting-approval",
    attempt: 1,
    canApprove: true,
    payload: { summary: "Drafted the quarterly report." },
    artifactDir: "/tmp/artifacts/i1/draft",
    artifacts: [],
    ...over,
  };
}

function content(path: string, over: Partial<PhaseArtifactContent> = {}): PhaseArtifactContent {
  return {
    path,
    bytes: 100,
    modifiedAt: "2026-07-07T10:00:00.000Z",
    text: true,
    truncated: false,
    content: "",
    ...over,
  };
}

const approve = vi.fn(() => new Promise<unknown>(() => {}));
const revise = vi.fn(() => new Promise<unknown>(() => {}));

function open(sel: GateSelection | null = selection) {
  return render(<GateDrawer selection={sel} onClose={vi.fn()} approve={approve} revise={revise} />);
}

beforeEach(() => {
  approve.mockClear();
  revise.mockClear();
  mockReview.review = review();
  mockReview.loading = false;
  mockReview.error = null;
  mockContent.clear();
  mockContentError.error = null;
});

describe("GateDrawer — content", () => {
  it("renders nothing without a selection", () => {
    open(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the phase, the payload, the result and the checks", () => {
    mockReview.review = review({
      result: { accepted: true },
      verification: {
        status: "passed",
        startedAt: "2026-07-07T10:00:00.000Z",
        endedAt: "2026-07-07T10:00:01.000Z",
        checks: [
          { kind: "artifact", label: "report.md", status: "passed", detail: "1.2 KiB", durationMs: 3 },
        ],
      },
    });
    open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Draft")).toBeInTheDocument();
    expect(within(dialog).getByText(/Reports · attempt 2/)).toBeInTheDocument();
    expect(within(dialog).getByText("Drafted the quarterly report.")).toBeInTheDocument();
    expect(within(dialog).getByTestId("gate-result")).toHaveTextContent('"accepted": true');
    expect(within(dialog).getByTestId("gate-verification")).toHaveTextContent("report.md");
    expect(within(dialog).getByText(/paused here until you decide/i)).toBeInTheDocument();
  });

  it("lists artifacts with a required badge and opens the required one first", () => {
    mockReview.review = review({
      artifacts: [
        { path: "notes.txt", bytes: 20, modifiedAt: "2026-07-07T10:00:00.000Z", required: false, text: true },
        { path: "report.md", bytes: 1200, modifiedAt: "2026-07-07T10:00:00.000Z", required: true, text: true },
      ],
    });
    mockContent.set("report.md", content("report.md", { content: "# Quarterly\n\nAll good." }));
    mockContent.set("notes.txt", content("notes.txt", { content: "plain notes" }));
    open();
    const list = screen.getByRole("list", { name: /artifacts/i });
    const items = within(list).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([
      expect.stringContaining("notes.txt"),
      expect.stringContaining("report.md"),
    ]);
    expect(items[1]).toHaveTextContent(/required/i);
    expect(items[1]).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("heading", { level: 1, name: "Quarterly" })).toBeInTheDocument();
  });

  it("renders a .md artifact as markdown and any other text as raw", () => {
    mockReview.review = review({
      artifacts: [
        { path: "report.md", bytes: 10, modifiedAt: "2026-07-07T10:00:00.000Z", required: true, text: true },
        { path: "log.txt", bytes: 10, modifiedAt: "2026-07-07T10:00:00.000Z", required: false, text: true },
      ],
    });
    mockContent.set("report.md", content("report.md", { content: "# Title\n\n- one\n- two" }));
    mockContent.set("log.txt", content("log.txt", { content: "# not a heading\nline 2" }));
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeInTheDocument();
    expect(screen.queryByText("# Title")).toBeNull();
    expect(screen.queryByTestId("artifact-raw")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /log\.txt/ }));
    expect(screen.getByTestId("artifact-raw")).toHaveTextContent("# not a heading line 2");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("shows a binary artifact as metadata only", () => {
    mockReview.review = review({
      artifacts: [
        { path: "chart.png", bytes: 4096, modifiedAt: "2026-07-07T10:00:00.000Z", required: false, text: false },
      ],
    });
    mockContent.set("chart.png", content("chart.png", { text: false, content: undefined, bytes: 4096 }));
    open();
    expect(screen.getByText(/binary — not shown here/i)).toBeInTheDocument();
    expect(screen.getAllByText("4.0 KiB").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("artifact-raw")).toBeNull();
  });

  it("says when a file is clipped", () => {
    mockReview.review = review({
      artifacts: [
        { path: "big.txt", bytes: 600000, modifiedAt: "2026-07-07T10:00:00.000Z", required: false, text: true },
      ],
    });
    mockContent.set("big.txt", content("big.txt", { bytes: 600000, truncated: true, content: "x".repeat(2048) }));
    open();
    expect(screen.getByText(/showing the first 2\.0 KiB of 586 KiB/i)).toBeInTheDocument();
  });

  it("states the empty case and still offers Approve", () => {
    open();
    expect(screen.getByTestId("gate-no-artifacts")).toHaveTextContent(/left no files.*approving continues/i);
    expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
  });

  it("reports a review that could not be loaded, and a file that could not", () => {
    mockReview.review = null;
    mockReview.error = "HTTP 500";
    open();
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load the review: HTTP 500/i);

    mockReview.review = review({
      artifacts: [
        { path: "report.md", bytes: 10, modifiedAt: "2026-07-07T10:00:00.000Z", required: true, text: true },
      ],
    });
    mockReview.error = null;
    mockContentError.error = "HTTP 404";
    open();
    expect(screen.getAllByRole("alert").at(-1)).toHaveTextContent(/couldn't load report\.md: HTTP 404/i);
  });

  it("shows a loading state before the review arrives", () => {
    mockReview.review = null;
    mockReview.loading = true;
    open();
    expect(screen.getByRole("status", { busy: true })).toBeInTheDocument();
  });
});

describe("GateDrawer — deciding", () => {
  it("Approve targets the phase and stays disabled after an accepted click", async () => {
    approve.mockImplementationOnce(() => Promise.resolve(new Response()));
    open();
    const btn = screen.getByRole("button", { name: /^approve$/i });
    fireEvent.click(btn);
    expect(approve).toHaveBeenCalledWith("i1", { phaseId: "draft" });
    expect(btn).toBeDisabled();
    expect(await screen.findByRole("status")).toHaveTextContent(/approved — pipeline resuming/i);
  });

  it("Revise on a gate needs a note; Send carries it and the phase", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /^revise$/i }));
    expect(screen.getByText(/this attempt's files are discarded/i)).toBeInTheDocument();
    const send = screen.getByRole("button", { name: /^send$/i });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/revision note/i), { target: { value: "   " } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/revision note/i), {
      target: { value: "shorter, please" },
    });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    expect(revise).toHaveBeenCalledWith("i1", "shorter, please", { phaseId: "draft" });
  });

  it("a failed phase offers no Approve; a restarted one retries with an optional note", () => {
    mockReview.review = review({
      status: "failed",
      canApprove: false,
      payload: { reason: "orphaned by a restart", kind: "restarted" },
    });
    open();
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    const send = screen.getByRole("button", { name: /^send$/i });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    expect(revise).toHaveBeenCalledWith("i1", undefined, { phaseId: "draft" });
  });

  it("surfaces an action error and re-enables the buttons", async () => {
    approve.mockImplementationOnce(() => Promise.reject(new Error("instance is not awaiting approval")));
    open();
    const btn = screen.getByRole("button", { name: /^approve$/i });
    fireEvent.click(btn);
    expect(await screen.findByRole("alert")).toHaveTextContent(/not awaiting approval/i);
    expect(btn).not.toBeDisabled();
  });
});
