import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import type { ChangeProposalPreview, PhaseArtifactContent, PhaseReview } from "../types";
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
          {
            kind: "artifact",
            label: "report.md",
            status: "passed",
            detail: "1.2 KiB",
            durationMs: 3,
          },
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

  it("lifts the reason and the closing note out of a Stop-hook payload and folds the rest", () => {
    mockReview.review = review({
      status: "failed",
      canApprove: false,
      payload: {
        session_id: "4eec19c6",
        transcript_path: "/Users/me/.claude/projects/x.jsonl",
        hook_event_name: "Stop",
        stop_hook_active: false,
        background_tasks: [],
        last_assistant_message:
          "## Ship\n\nRepo is clean, **fsck passes**.\n\nARGUS_OUTCOME: blocked — no remote",
        reason: "blocked: no remote",
        failureClass: "signal",
      },
    });
    open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("What went wrong")).toBeInTheDocument();
    expect(within(dialog).getByTestId("gate-reason")).toHaveTextContent("blocked: no remote");
    // The note is rendered, not dumped: its heading is a heading and its
    // emphasis is markup.
    const note = within(dialog).getByTestId("gate-closing-note");
    expect(within(note).getByRole("heading", { level: 2, name: "Ship" })).toBeInTheDocument();
    expect(within(note).getByText("fsck passes").tagName).toBe("STRONG");
    // The hook event's bookkeeping is behind a closed toggle, without the
    // fields already shown above it.
    const raw = within(dialog).getByTestId("gate-raw-payload");
    const details = raw.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(raw).toHaveTextContent('"hook_event_name": "Stop"');
    expect(raw).toHaveTextContent('"failureClass": "signal"');
    expect(raw).not.toHaveTextContent("last_assistant_message");
    expect(raw).not.toHaveTextContent('"reason"');
    fireEvent.click(within(dialog).getByText("Raw payload"));
    expect(details).toHaveAttribute("open");
  });

  it("shows a summary-only payload as a rendered note with no raw toggle", () => {
    mockReview.review = review({ payload: { summary: "Drafted the *quarterly* report." } });
    open();
    const dialog = screen.getByRole("dialog");
    const note = within(dialog).getByTestId("gate-closing-note");
    expect(within(note).getByText("quarterly").tagName).toBe("EM");
    expect(within(dialog).queryByTestId("gate-raw-payload")).toBeNull();
    expect(within(dialog).queryByText("Raw payload")).toBeNull();
  });

  it("renders a string payload as the closing note and a prose-less object raw", () => {
    mockReview.review = review({ payload: "- one\n- two" });
    open();
    let dialog = screen.getByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(expect.arrayContaining(["one", "two"]));
    expect(within(dialog).queryByTestId("gate-raw-payload")).toBeNull();
    cleanup();

    mockReview.review = review({ payload: { kind: "restarted", attempt: 2 } });
    open();
    dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByTestId("gate-closing-note")).toBeNull();
    const raw = within(dialog).getByTestId("gate-raw-payload");
    expect(raw).toHaveTextContent('"kind": "restarted"');
    expect(raw.closest("details")).toBeNull();
  });

  it("lists artifacts with a required badge and opens the required one first", () => {
    mockReview.review = review({
      artifacts: [
        {
          path: "notes.txt",
          bytes: 20,
          modifiedAt: "2026-07-07T10:00:00.000Z",
          required: false,
          text: true,
        },
        {
          path: "report.md",
          bytes: 1200,
          modifiedAt: "2026-07-07T10:00:00.000Z",
          required: true,
          text: true,
        },
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
        {
          path: "report.md",
          bytes: 10,
          modifiedAt: "2026-07-07T10:00:00.000Z",
          required: true,
          text: true,
        },
        {
          path: "log.txt",
          bytes: 10,
          modifiedAt: "2026-07-07T10:00:00.000Z",
          required: false,
          text: true,
        },
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
        {
          path: "chart.png",
          bytes: 4096,
          modifiedAt: "2026-07-07T10:00:00.000Z",
          required: false,
          text: false,
        },
      ],
    });
    mockContent.set(
      "chart.png",
      content("chart.png", { text: false, content: undefined, bytes: 4096 }),
    );
    open();
    expect(screen.getByText(/binary — not shown here/i)).toBeInTheDocument();
    expect(screen.getAllByText("4.0 KiB").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("artifact-raw")).toBeNull();
  });

  it("says when a file is clipped", () => {
    mockReview.review = review({
      artifacts: [
        {
          path: "big.txt",
          bytes: 600000,
          modifiedAt: "2026-07-07T10:00:00.000Z",
          required: false,
          text: true,
        },
      ],
    });
    mockContent.set(
      "big.txt",
      content("big.txt", { bytes: 600000, truncated: true, content: "x".repeat(2048) }),
    );
    open();
    expect(screen.getByText(/showing the first 2\.0 KiB of 586 KiB/i)).toBeInTheDocument();
  });

  it("states the empty case and still offers Approve", () => {
    open();
    expect(screen.getByTestId("gate-no-artifacts")).toHaveTextContent(
      /left no files.*approving continues/i,
    );
    expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
  });

  it("reports a review that could not be loaded, and a file that could not", () => {
    mockReview.review = null;
    mockReview.error = "HTTP 500";
    open();
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load the review: HTTP 500/i);

    mockReview.review = review({
      artifacts: [
        {
          path: "report.md",
          bytes: 10,
          modifiedAt: "2026-07-07T10:00:00.000Z",
          required: true,
          text: true,
        },
      ],
    });
    mockReview.error = null;
    mockContentError.error = "HTTP 404";
    open();
    expect(screen.getAllByRole("alert").at(-1)).toHaveTextContent(
      /couldn't load report\.md: HTTP 404/i,
    );
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
    approve.mockImplementationOnce(() =>
      Promise.reject(new Error("instance is not awaiting approval")),
    );
    open();
    const btn = screen.getByRole("button", { name: /^approve$/i });
    fireEvent.click(btn);
    expect(await screen.findByRole("alert")).toHaveTextContent(/not awaiting approval/i);
    expect(btn).not.toBeDisabled();
  });
});

// ── Candidate knowledge (Phase 5) ───────────────────────────────────────────

import type { KnowledgeDeltaPreview } from "../types";

function preview(over: Partial<KnowledgeDeltaPreview> = {}): KnowledgeDeltaPreview {
  return {
    deltaId: "KD-1",
    runId: "run-7",
    step: "investigate",
    attempt: 0,
    status: "staged",
    proposedClaims: [
      {
        ref: { display: "local:comment-limit", local: "comment-limit" },
        kind: "business-rule",
        statement: "Kobra bookings restrict customer comments to 180 characters.",
        evidence: [
          {
            claim: { display: "local:comment-limit", local: "comment-limit" },
            direction: "supports",
            source: {
              type: "source-code",
              path: "src/Booking/KobraAdapter.cs",
              gitHead: "abc123def4567890",
              symbol: "KobraAdapter.MapComment",
              startLine: 120,
              endLine: 136,
            },
            note: "truncates at 180",
          },
        ],
        justifications: [
          {
            conclusion: { display: "local:comment-limit", local: "comment-limit" },
            premises: [{ display: "local:kobra-origin", local: "kobra-origin" }],
            direction: "supports",
          },
        ],
      },
      {
        ref: { display: "local:kobra-origin", local: "kobra-origin" },
        kind: "assumption",
        statement: "The limit is a Kobra integration constraint.",
        evidence: [],
        justifications: [],
      },
    ],
    proposedRevisions: [
      {
        claimId: "RULE-17",
        expectedRevision: 1,
        ref: {
          display: "RULE-17:v2 (proposed)",
          claim: { id: "RULE-17", revision: 2 },
          proposed: true,
        },
        kind: "business-rule",
        statement: "Kobra comments max = 500",
        revisionNote: "the adapter truncates at 500",
        current: {
          claim: { id: "RULE-17", revision: 1 },
          statement: "Kobra comments max = 180",
          support: "supported",
          lifecycle: "active",
        },
        evidence: [],
        justifications: [],
      },
    ],
    evidence: [],
    justifications: [],
    consumed: [{ ref: "RULE-17:v1", claim: { id: "RULE-17", revision: 1 } }],
    artifacts: [],
    warnings: [
      {
        code: "assumption-without-evidence",
        subject: "local:kobra-origin",
        message: "assumption carries neither evidence nor a justification",
      },
    ],
    ...over,
  };
}

describe("GateDrawer — candidate knowledge", () => {
  it("shows the proposed rules, their evidence and the warnings, without a transcript", () => {
    mockReview.review = review({
      knowledge: [preview()],
      discovery: {
        candidates: 3,
        newRules: 1,
        revisions: 1,
        assumptions: 1,
        facts: 0,
        constraints: 0,
        conclusions: 0,
        evidence: 1,
        warnings: 1,
        requiresReview: true,
      },
    });
    open();
    const panel = screen.getByTestId("gate-candidate-knowledge");
    expect(panel).toHaveTextContent(/3 candidates · 1 new rule · 1 revision · 1 assumption/);
    expect(panel).toHaveTextContent(/Nothing here is canonical yet/);

    // The rule, with its kind and the source location behind it.
    expect(panel).toHaveTextContent(/Kobra bookings restrict customer comments to 180/);
    expect(panel).toHaveTextContent(/src\/Booking\/KobraAdapter\.cs:120-136@abc123de/);
    expect(panel).toHaveTextContent(/KobraAdapter\.MapComment/);
    expect(panel).toHaveTextContent(/from local:kobra-origin/);

    // A proposed claim is named honestly: no canonical id is implied.
    expect(panel).toHaveTextContent(/local:comment-limit/);
    expect(within(panel).getAllByText("business-rule").length).toBeGreaterThan(0);
    expect(within(panel).getByText("assumption")).toBeInTheDocument();

    // The revision shows before and after.
    expect(panel).toHaveTextContent(/RULE-17 v1 → v2/);
    expect(panel).toHaveTextContent(/Kobra comments max = 180/);
    expect(panel).toHaveTextContent(/Kobra comments max = 500/);

    // The deterministic warning, and the un-evidenced assumption called out.
    expect(screen.getByTestId("candidate-warnings")).toHaveTextContent(
      /carries neither evidence nor a justification/,
    );
    expect(screen.getAllByTestId("candidate-no-evidence").length).toBeGreaterThan(0);

    // …and the consumption the run declared.
    expect(panel).toHaveTextContent(/consumed: RULE-17:v1/);
  });

  it("marks a stale revision so a reviewer knows the commit will refuse it", () => {
    mockReview.review = review({
      knowledge: [
        preview({
          proposedClaims: [],
          proposedRevisions: [
            {
              claimId: "RULE-17",
              expectedRevision: 1,
              ref: {
                display: "RULE-17:v2 (proposed)",
                claim: { id: "RULE-17", revision: 2 },
                proposed: true,
              },
              statement: "Kobra comments max = 500",
              stale: true,
              current: {
                claim: { id: "RULE-17", revision: 2 },
                statement: "Kobra comments max = 300",
                support: "supported",
                lifecycle: "active",
              },
              evidence: [],
              justifications: [],
            },
          ],
          warnings: [],
        }),
      ],
    });
    open();
    expect(screen.getByTestId("gate-candidate-knowledge")).toHaveTextContent(/stale/);
  });

  it("is absent on an ordinary gate that proposed no knowledge", () => {
    mockReview.review = review();
    open();
    expect(screen.queryByTestId("gate-candidate-knowledge")).toBeNull();
  });
});

describe("GateDrawer — candidate knowledge on a failed phase", () => {
  it("says the candidates never became canonical rather than offering to commit them", () => {
    mockReview.review = review({
      status: "failed",
      canApprove: false,
      payload: { reason: "the ledger moved while the gate waited" },
      knowledge: [preview({ status: "rejected", warnings: [] })],
    });
    open();
    const panel = screen.getByTestId("gate-candidate-knowledge");
    expect(panel).toHaveTextContent(/None of this became canonical/);
    expect(panel).not.toHaveTextContent(/approving commits it/);
  });
});

/**
 * The Phase 6 review surface. A reviewer must be able to see, without opening
 * a transcript, both halves of the question: what the code does, and what the
 * rule itself stands on. A panel that showed only "VIOLATED" would eventually
 * teach somebody to "fix" a rule whose implementation was merely in breach.
 */
function verificationPreview(
  over: Partial<PhaseReview["ruleVerifications"] extends (infer T)[] | undefined ? T : never> = {},
) {
  return {
    recordId: "RV-1",
    runId: "run-a",
    step: "verify",
    attempt: 0,
    status: "staged" as const,
    gitHead: "abc123def4567890abc123def4567890abc123de",
    holds: [
      {
        ref: "RULE-9:v2",
        rule: { id: "RULE-9", revision: 2 },
        statement: "External bookings require a CRM id",
        kind: "business-rule" as const,
        support: "supported" as const,
        lifecycle: "active" as const,
        outcome: "holds" as const,
        evidence: [
          {
            type: "check" as const,
            label: "crm-id-tests",
            status: "passed" as const,
            exitCode: 0,
            detail: "exit 0",
          },
        ],
      },
    ],
    violated: [
      {
        ref: "RULE-42:v1",
        rule: { id: "RULE-42", revision: 1 },
        statement: "Kobra customer comments must not exceed 180 characters",
        kind: "business-rule" as const,
        support: "supported" as const,
        lifecycle: "active" as const,
        outcome: "violated" as const,
        evidence: [
          {
            type: "source-code" as const,
            path: "src/Booking/KobraCommentValidator.cs",
            startLine: 3,
            endLine: 6,
          },
        ],
        note: "MaxLength is 500",
      },
    ],
    unverifiable: [
      {
        ref: "RULE-51:v1",
        rule: { id: "RULE-51", revision: 1 },
        statement: "Refunds are approved by a manager",
        outcome: "unverifiable" as const,
        evidence: [],
        reason: "no code path in this repository expresses manager approval",
      },
    ],
    missing: [],
    summary: "One rule holds, one is violated, one cannot be checked here.",
    ...over,
  };
}

describe("GateDrawer — business-rule verification", () => {
  it("groups the outcomes and shows each rule's own support beside its conformance", () => {
    mockReview.review = review({
      ruleVerifications: [verificationPreview()],
      ruleVerification: {
        selected: 3,
        holds: 1,
        violated: 1,
        unverifiable: 1,
        requiresReview: true,
      },
    });
    open();
    const panel = screen.getByTestId("gate-rule-verification");

    // The counts and the commit the results are bound to.
    expect(panel).toHaveTextContent(/1 holds · 1 violated · 1 unverifiable/);
    expect(panel).toHaveTextContent(/at abc123de/);
    expect(panel).toHaveTextContent(/Nothing here is durable yet/);

    // Each outcome group, with its rows.
    expect(within(screen.getByLabelText("Holds")).getByText(/External bookings/)).toBeTruthy();
    const violated = within(screen.getByLabelText("Violated"));
    expect(violated.getByText(/Kobra customer comments/)).toBeTruthy();

    // THE distinction: the code is in breach and the rule still stands.
    expect(panel).toHaveTextContent(/violated/);
    expect(panel).toHaveTextContent(/rule: supported/);

    // Evidence is concise and names the deterministic check Argus ran.
    expect(panel).toHaveTextContent(/check: crm-id-tests \(passed, exit 0\)/);
    expect(panel).toHaveTextContent(/src\/Booking\/KobraCommentValidator\.cs:3-6/);

    // Unverifiable is its own group, with the verifier's reason rather than a
    // silent absence.
    const unverifiable = within(screen.getByLabelText("Unverifiable"));
    expect(unverifiable.getByText(/no code path in this repository/)).toBeTruthy();
  });

  it("names a selected rule the agent left without an outcome", () => {
    mockReview.review = review({
      ruleVerifications: [
        verificationPreview({
          holds: [],
          violated: [],
          unverifiable: [],
          missing: ["RULE-42:v1"],
          status: "rejected",
        }),
      ],
      canApprove: false,
      status: "failed",
    });
    open();
    expect(screen.getByTestId("gate-verification-missing")).toHaveTextContent(
      /No outcome submitted for RULE-42:v1/,
    );
    expect(screen.getByTestId("gate-rule-verification")).toHaveTextContent(
      /None of this became durable/,
    );
  });

  it("is absent entirely on an ordinary phase", () => {
    mockReview.review = review();
    open();
    expect(screen.queryByTestId("gate-rule-verification")).toBeNull();
  });
});

// ── Change intent (Phase 7) ──────────────────────────────────────────────────

function changePreview(over: Partial<ChangeProposalPreview> = {}): ChangeProposalPreview {
  return {
    proposalId: "CP-12",
    runId: "run-1",
    step: "reason",
    attempt: 1,
    status: "staged",
    readiness: "ready",
    request: {
      id: "CR-1",
      summary: "Kobra now supports 500-character customer comments.",
      details: "The integration team confirmed the new limit.",
    },
    current: [
      {
        ref: "RULE-42:v1",
        claim: { id: "RULE-42", revision: 1 },
        kind: "business-rule",
        statement: "Kobra customer comments must not exceed 180 characters.",
        support: "supported",
        lifecycle: "active",
        conformance: "holds",
        conformanceAt: "abc123def456",
      },
    ],
    semantic: {
      deltaId: "KD-9",
      runId: "run-1",
      step: "reason",
      attempt: 1,
      status: "staged",
      proposedClaims: [
        {
          ref: { display: "local:d1", local: "d1" },
          kind: "decision",
          statement: "The 500-character limit applies only when BookingEngine == Kobra.",
          evidence: [],
          justifications: [
            {
              conclusion: { display: "local:d1", local: "d1" },
              premises: [
                { display: "local:r42", local: "r42" },
                { display: "CONSTRAINT-8:v1", claim: { id: "CONSTRAINT-8", revision: 1 } },
              ],
              direction: "supports",
            },
          ],
        },
      ],
      proposedRevisions: [
        {
          claimId: "RULE-42",
          expectedRevision: 1,
          ref: {
            display: "RULE-42:v2 (proposed)",
            claim: { id: "RULE-42", revision: 2 },
            proposed: true,
          },
          kind: "business-rule",
          statement: "Kobra customer comments must not exceed 500 characters.",
          current: {
            claim: { id: "RULE-42", revision: 1 },
            statement: "Kobra customer comments must not exceed 180 characters.",
            support: "supported",
            lifecycle: "active",
          },
          evidence: [],
          justifications: [],
        },
      ],
      evidence: [],
      justifications: [],
      consumed: [],
      artifacts: [],
      warnings: [],
    },
    preserved: [
      {
        ref: "CONSTRAINT-8:v1",
        claim: { id: "CONSTRAINT-8", revision: 1 },
        kind: "constraint",
        statement: "Comment validation is enforced server-side.",
      },
    ],
    acceptanceCriteria: [
      {
        id: "AC-1",
        statement: "A Kobra comment of 500 characters is accepted.",
        kind: "behavior",
        relatesTo: [{ local: "r42" }],
      },
      {
        id: "AC-2",
        statement: "A Kobra comment of 501 characters is rejected.",
        kind: "behavior",
        relatesTo: [{ local: "r42" }],
      },
      {
        id: "AC-3",
        statement: "Non-Kobra comment limits are unchanged.",
        kind: "regression",
        relatesTo: [{ id: "CONSTRAINT-8", revision: 1 }],
      },
    ],
    unresolved: [],
    classification: [{ rule: { id: "RULE-42", revision: 1 }, disposition: "revised" }],
    warnings: [],
    summary: "Raise the Kobra limit; keep server-side validation.",
    ...over,
  };
}

describe("GateDrawer — change intent", () => {
  it("shows the request, the current rule with its conformance, and the proposed transition", () => {
    mockReview.review = review({
      changeProposals: [changePreview()],
      changeIntent: {
        requestId: "CR-1",
        readiness: "ready",
        selected: 1,
        revised: 1,
        created: 1,
        decisions: 1,
        preserved: 1,
        acceptanceCriteria: 3,
        unresolved: 0,
        warnings: 0,
        requiresReview: true,
      },
    });
    open();
    const panel = screen.getByTestId("gate-change-proposal");

    // What was asked for, verbatim, and whether the intent is fit to implement.
    expect(screen.getByTestId("change-request")).toHaveTextContent(/500-character customer/);
    expect(screen.getByTestId("change-readiness")).toHaveTextContent("ready");

    // CURRENT — the rule's own support beside what the implementation does.
    // Collapsing these two is how a bug becomes a requirement.
    const current = within(screen.getByLabelText("Current rules"));
    expect(current.getByText(/must not exceed 180 characters/)).toBeTruthy();
    expect(panel).toHaveTextContent(/rule: supported/);
    expect(panel).toHaveTextContent(/impl: holds @abc123de/);

    // PROPOSED — before and after, plus the decision that follows.
    const revisions = within(screen.getByLabelText("Proposed revisions"));
    expect(revisions.getByText(/must not exceed 500 characters/)).toBeTruthy();
    expect(
      within(screen.getByLabelText("Decisions")).getByText(/BookingEngine == Kobra/),
    ).toBeTruthy();

    // PRESERVED — named by exact ref, with no new claim invented to say so.
    expect(screen.getByTestId("change-preserved")).toHaveTextContent(/CONSTRAINT-8:v1/);

    // ACCEPTANCE CRITERIA — their own section, never rendered as claims.
    const criteria = screen.getByTestId("change-acceptance-criteria");
    expect(criteria).toHaveTextContent(/AC-1/);
    expect(criteria).toHaveTextContent(/501 characters is rejected/);
    expect(criteria).toHaveTextContent(/regression/);

    expect(screen.getByTestId("change-unresolved-none")).toHaveTextContent("none");
    expect(panel).toHaveTextContent(/Nothing here is canonical yet/);
  });

  it("marks an unfinished proposal needs-input and lists what is unknown", () => {
    mockReview.review = review({
      changeProposals: [
        changePreview({
          readiness: "needs-input",
          semantic: undefined,
          acceptanceCriteria: [],
          unresolved: [{ id: "Q-1", question: "What should the new maximum be?" }],
          warnings: [
            {
              code: "unresolved-questions",
              subject: "Q-1",
              message: "1 question is unresolved, so this proposal is not implementation-ready",
            },
          ],
        }),
      ],
    });
    open();
    expect(screen.getByTestId("change-readiness")).toHaveTextContent("needs-input");
    expect(screen.getByTestId("change-unresolved")).toHaveTextContent(
      /What should the new maximum be\?/,
    );
    expect(screen.getByTestId("change-warnings")).toHaveTextContent(/not implementation-ready/);
    // No acceptance criteria is itself worth seeing, rather than an empty list.
    expect(screen.getByTestId("gate-change-proposal")).toHaveTextContent(
      /no observable way to judge/,
    );
  });

  it("says plainly when a failed phase's proposal never became canonical", () => {
    mockReview.review = review({
      changeProposals: [changePreview({ status: "rejected" })],
      canApprove: false,
      status: "failed",
    });
    open();
    expect(screen.getByTestId("gate-change-proposal")).toHaveTextContent(
      /None of this became canonical/,
    );
  });

  it("renders nothing for an ordinary phase", () => {
    mockReview.review = review();
    open();
    expect(screen.queryByTestId("gate-change-proposal")).toBeNull();
  });
});

// ── Acceptance verification and change realization (Phase 8) ─────────────────
//
// The state the panel exists to make visible: every business rule holds, and
// the criterion that says "non-Kobra behaviour is unchanged" is violated. A
// reviewer who could not see both dimensions at once would eventually approve
// exactly that, and call the change done.

function acceptancePreview(over: Record<string, unknown> = {}) {
  return {
    recordId: "AVR-1",
    runId: "run-b",
    step: "verify",
    attempt: 1,
    status: "staged" as const,
    proposalId: "CP-12",
    repository: {
      gitHead: "abc123def4567890abc123def4567890abc123de",
      workingTree: { snapshotHash: "f".repeat(64), dirty: 2 },
    },
    satisfied: [
      {
        ref: "CP-12/AC-1",
        criterionId: "AC-1",
        statement: "A Kobra comment of 500 characters is accepted.",
        kind: "behavior" as const,
        relatesTo: [{ id: "RULE-42", revision: 2 }],
        outcome: "satisfied" as const,
        evidence: [
          {
            type: "check" as const,
            label: "kobra-comment-500",
            status: "passed" as const,
            exitCode: 0,
            detail: "exit 0",
          },
        ],
      },
    ],
    violated: [
      {
        ref: "CP-12/AC-3",
        criterionId: "AC-3",
        statement: "Non-Kobra comment limits are unchanged.",
        kind: "regression" as const,
        relatesTo: [{ id: "CONSTRAINT-8", revision: 1 }],
        outcome: "violated" as const,
        evidence: [{ type: "source-code" as const, path: "src/Booking/LegacyValidator.cs" }],
        note: "the legacy cap moved to 500 too",
      },
    ],
    unverifiable: [],
    missing: [],
    summary: "Two of three criteria answered against the working tree.",
    ...over,
  };
}

describe("GateDrawer — acceptance criteria", () => {
  it("shows criterion outcomes beside the rule outcomes, never merged into them", () => {
    mockReview.review = review({
      ruleVerifications: [verificationPreview({ violated: [], unverifiable: [], missing: [] })],
      ruleVerification: {
        selected: 1,
        holds: 1,
        violated: 0,
        unverifiable: 0,
        requiresReview: true,
      },
      acceptanceVerifications: [acceptancePreview()],
      acceptanceVerification: {
        proposalId: "CP-12",
        required: 2,
        satisfied: 1,
        violated: 1,
        unverifiable: 0,
        requiresReview: true,
      },
    } as never);
    open();

    // Every rule holds …
    expect(screen.getByTestId("gate-rule-verification")).toHaveTextContent(/1 holds · 0 violated/);
    // … and the change is still not complete.
    const panel = screen.getByTestId("gate-acceptance-verification");
    expect(panel).toHaveTextContent(/1 satisfied · 1 violated · 0 unverifiable/);
    expect(panel).toHaveTextContent(/for CP-12/);
    expect(panel).toHaveTextContent(/at abc123de/);
    expect(panel).toHaveTextContent(/\+2 uncommitted/);
    expect(panel).toHaveTextContent(/Nothing here is durable yet/);

    const violated = within(screen.getByLabelText("Violated"));
    expect(violated.getByText(/Non-Kobra comment limits are unchanged/)).toBeTruthy();
    // The criterion is addressed by the pair, and names the revision it is
    // evidence for.
    expect(panel).toHaveTextContent(/CP-12\/AC-3/);
    expect(panel).toHaveTextContent(/CONSTRAINT-8:v1/);
    // A cited check shows as Argus observed it.
    expect(panel).toHaveTextContent(/check: kobra-comment-500 \(passed, exit 0\)/);
  });

  it("names a criterion the agent left without an outcome", () => {
    mockReview.review = review({
      acceptanceVerifications: [
        acceptancePreview({ satisfied: [], violated: [], missing: ["AC-2"], status: "rejected" }),
      ],
      canApprove: false,
      status: "failed",
    } as never);
    open();
    expect(screen.getByTestId("gate-acceptance-missing")).toHaveTextContent(
      /No outcome submitted for AC-2/,
    );
    expect(screen.getByTestId("gate-acceptance-verification")).toHaveTextContent(
      /None of this became durable/,
    );
  });

  it("says which accepted change is being realized, and which attempt this is", () => {
    mockReview.review = review({
      realization: {
        id: "CR-7",
        proposalId: "CP-12",
        attempt: 2,
        kind: "remediation",
        maxAttempts: 2,
        repository: {
          gitHead: "abc123def4567890abc123def4567890abc123de",
          workingTree: { snapshotHash: "f".repeat(64), dirty: 1 },
        },
      },
    } as never);
    open();
    const header = screen.getByTestId("gate-realization");
    expect(header).toHaveTextContent(/Realizing CP-12/);
    expect(header).toHaveTextContent(/CR-7/);
    expect(header).toHaveTextContent(/remediation attempt 2 of 2/);
    expect(header).toHaveTextContent(/abc123de with 1 uncommitted file/);
  });

  it("is absent entirely on an ordinary phase", () => {
    mockReview.review = review();
    open();
    expect(screen.queryByTestId("gate-acceptance-verification")).toBeNull();
    expect(screen.queryByTestId("gate-realization")).toBeNull();
  });
});
