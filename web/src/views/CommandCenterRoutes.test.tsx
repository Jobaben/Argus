import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { OverviewEntry } from "../types";
import CommandCenter from "./CommandCenter";

/**
 * The board, reading a routed instance.
 *
 * The question a conditional pipeline gets asked is "why did that one not
 * run?", and the board has to answer it without the reader opening the journal:
 * a skipped phase that says skipped, the condition on each edge that decides,
 * and the decision itself in one line.
 */

vi.mock("../useOverview", () => ({
  useOverview: () => ({
    overview: mockOverview.overview,
    loading: false,
    error: null,
    refresh: vi.fn(),
    approve: vi.fn(),
    revise: vi.fn(),
  }),
}));
vi.mock("../useRunActivity", () => ({ useRunActivity: () => new Map() }));
vi.mock("../useTotals", () => ({
  useTotals: () => ({
    totals: null,
    loading: false,
    error: null,
    reset: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const mockOverview: { overview: OverviewEntry[] } = { overview: [] };

const accepted = (value: boolean) => ({
  predicate: { path: ["accepted"], operator: "equals" as const, value },
});

/** The spec's worked example, run with `accepted: true`. */
function routed(): OverviewEntry {
  return {
    cost: null,
    active: [],
    definition: {
      id: "audit",
      name: "audit",
      phases: [
        {
          id: "evaluate",
          name: "Evaluate",
          cwd: "/",
          gated: false,
          steps: [{ name: "decide", prompt: "x" }],
          result: {
            artifact: "evaluation",
            schema: {
              type: "object",
              required: ["accepted"],
              properties: { accepted: { type: "boolean" } },
            },
          },
        },
        {
          id: "publish",
          name: "Publish",
          cwd: "/",
          gated: false,
          steps: [{ name: "ship", prompt: "x" }],
          needs: [{ phase: "evaluate", when: accepted(true) }],
        },
        {
          id: "repair",
          name: "Repair",
          cwd: "/",
          gated: false,
          steps: [{ name: "fix", prompt: "x" }],
          needs: [{ phase: "evaluate", when: accepted(false) }],
        },
        {
          id: "report",
          name: "Report",
          cwd: "/",
          gated: false,
          steps: [{ name: "write", prompt: "x" }],
          needs: [
            { phase: "publish", allowSkipped: true },
            { phase: "repair", allowSkipped: true },
          ],
        },
      ],
      trigger: null,
      enabled: true,
      overlapPolicy: "skip",
      lastStartedAt: null,
      createdAt: "2026-08-13T09:00:00.000Z",
      updatedAt: "2026-08-13T09:00:00.000Z",
    },
    latest: {
      id: "audit-i1",
      pipelineId: "audit",
      pipelineName: "audit",
      status: "succeeded",
      currentPhaseIndex: 1,
      phases: [
        {
          id: "evaluate",
          name: "Evaluate",
          gated: false,
          status: "succeeded",
          steps: [{ name: "decide", runId: "r1", status: "succeeded" }],
          attempt: 0,
          needs: [],
          payload: null,
          result: { accepted: true },
        },
        {
          id: "publish",
          name: "Publish",
          gated: false,
          status: "succeeded",
          steps: [{ name: "ship", runId: "r2", status: "succeeded" }],
          attempt: 0,
          needs: ["evaluate"],
          payload: null,
        },
        {
          id: "repair",
          name: "Repair",
          gated: false,
          status: "skipped",
          steps: [{ name: "fix", runId: null, status: "skipped" }],
          attempt: 0,
          needs: ["evaluate"],
          payload: null,
        },
        {
          id: "report",
          name: "Report",
          gated: false,
          status: "succeeded",
          steps: [{ name: "write", runId: "r3", status: "succeeded" }],
          attempt: 0,
          needs: ["publish", "repair"],
          payload: null,
        },
      ],
      trigger: "manual",
      signalToken: "tok",
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:05:00.000Z",
      endedAt: "2026-08-13T12:05:00.000Z",
      artifacts: { evaluation: { accepted: true } },
      routeDecisions: [
        {
          sourcePhase: "evaluate",
          artifact: "evaluation",
          value: { accepted: true },
          selected: ["publish"],
          skipped: ["repair"],
          reason: "selected publish (accepted equals true); skipped repair (accepted equals false)",
        },
      ],
    },
  };
}

beforeEach(() => {
  mockOverview.overview = [routed()];
});

describe("the board on a routed instance", () => {
  it("marks the skipped branch as skipped rather than idle", () => {
    render(<CommandCenter />);
    const chip = screen.getByRole("button", { name: /Repair/ });
    expect(chip.getAttribute("title")).toMatch(/skipped/);
    expect(chip.getAttribute("title")).not.toMatch(/idle/);
    expect(chip.textContent).toMatch(/skip/);
  });

  it("draws the condition that governs a conditional branch", () => {
    render(<CommandCenter />);
    const chip = screen.getByRole("button", { name: /Publish/ });
    expect(chip.textContent).toMatch(/if Evaluate: accepted = true/);
    expect(screen.getByRole("button", { name: /Report/ }).getAttribute("title")).toMatch(
      /accepts publish skipped/,
    );
  });

  it("explains the decision on the phase that took it", () => {
    render(<CommandCenter />);
    // The focus follows the action; pin the deciding phase to read its panel.
    fireEvent.click(screen.getAllByRole("button", { name: /Evaluate/ })[0]);
    const decision = screen.getByTestId("phase-decision");
    expect(decision.textContent).toMatch(/evaluation/);
    expect(decision.textContent).toMatch(/\{"accepted":true\}/);
    expect(decision.textContent).toMatch(/→ Publish/);
    expect(decision.textContent).toMatch(/skipped Repair/);
  });

  it("explains a skipped phase in the words of the decision that skipped it", () => {
    render(<CommandCenter />);
    // The focus follows the action; pin the skipped phase to read its panel.
    fireEvent.click(screen.getByRole("button", { name: /Repair/ }));
    expect(screen.getByTestId("phase-skip").textContent).toMatch(
      /Not selected — Evaluate: accepted = false/,
    );
  });

  it("says nothing about routing on an instance that does not route", () => {
    const plain = routed();
    plain.definition.phases = plain.definition.phases.slice(0, 1).map((p) => ({
      ...p,
      result: undefined,
      needs: undefined,
    }));
    plain.latest!.phases = plain.latest!.phases.slice(0, 1);
    plain.latest!.routeDecisions = undefined;
    mockOverview.overview = [plain];
    render(<CommandCenter />);
    expect(screen.queryByTestId("phase-decision")).toBeNull();
    expect(screen.queryByTestId("phase-skip")).toBeNull();
    expect(screen.getByRole("button", { name: /Evaluate/ }).textContent).not.toMatch(/skip/);
  });
});
