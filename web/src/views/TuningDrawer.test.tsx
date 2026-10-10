import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TuningDrawer } from "./TuningDrawer";
import type { PipelineDefinition, PipelineInput, TuningReport } from "../types";

class FakeWS {
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

beforeEach(() => vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SECRET_PROMPT = "Refactor the payment module across every call site.";

const def: PipelineDefinition = {
  id: "p1",
  name: "Nightly",
  phases: [
    {
      id: "plan",
      name: "Plan",
      cwd: "/",
      gated: false,
      steps: [{ name: "draft", prompt: "Write a plan.", model: "opus" }],
    },
    {
      id: "build",
      name: "Build",
      cwd: "/",
      gated: false,
      steps: [{ name: "implement", prompt: SECRET_PROMPT }],
    },
  ],
  trigger: null,
  enabled: true,
  overlapPolicy: "skip",
  model: "sonnet",
  lastStartedAt: null,
  createdAt: "",
  updatedAt: "",
};

function report(over: Partial<TuningReport> = {}): TuningReport {
  return {
    id: "r1",
    pipelineId: "p1",
    pipelineName: "Nightly",
    status: "ready",
    startedAt: "2026-09-17T10:00:00.000Z",
    endedAt: "2026-09-17T10:01:00.000Z",
    phasesDone: 2,
    phasesTotal: 2,
    costUsd: 0.01,
    tokens: 500,
    error: null,
    phases: [
      {
        phaseId: "plan",
        phaseName: "Plan",
        status: "ready",
        summary: "A short plan does not need the flagship model.",
        proposals: [
          {
            phaseId: "plan",
            phaseName: "Plan",
            scope: "step",
            stepName: "draft",
            stepIndex: 0,
            field: "model",
            current: "opus",
            proposed: "haiku",
            inheritedFrom: "step",
            before: "opus",
            after: "haiku",
            reason: "'Write a plan' is a short read; the flagship model is overkill.",
          },
          {
            phaseId: "plan",
            phaseName: "Plan",
            scope: "step",
            stepName: "draft",
            stepIndex: 0,
            field: "timeoutSeconds",
            current: null,
            proposed: 300,
            inheritedFrom: "cli",
            before: "unset",
            after: "300",
            reason: "A plan should not run unbounded.",
          },
        ],
        unchanged: [],
        warnings: ['dropped a proposal for "prompt": not a tunable setting'],
        costUsd: 0.005,
        tokens: 250,
        durationMs: 3000,
        error: null,
      },
      {
        phaseId: "build",
        phaseName: "Build",
        status: "ready",
        summary: "Fits.",
        proposals: [],
        unchanged: ["implement"],
        warnings: [],
        costUsd: 0.005,
        tokens: 250,
        durationMs: 3000,
        error: null,
      },
    ],
    ...over,
  };
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** GET returns the given report; POST is recorded and answers 202. */
function tuneFetch(r: TuningReport | null, unavailable: string | null = null) {
  const posts: string[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(url);
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({ report: r, unavailable: null }),
      } as Response);
    }
    return Promise.resolve(okJson({ report: r, unavailable }));
  });
  return { fn, posts };
}

describe("TuningDrawer", () => {
  it("starts a pass on open when none is running", async () => {
    const { fn, posts } = tuneFetch(null);
    vi.stubGlobal("fetch", fn);
    render(<TuningDrawer def={def} onClose={() => {}} onApply={async () => {}} />);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toContain("/api/pipelines/p1/tune");
  });

  it("does not start a second pass when one is already running, and says where it is", async () => {
    const { fn, posts } = tuneFetch(
      report({
        status: "running",
        endedAt: null,
        phasesDone: 1,
        phases: [
          { ...report().phases[0] },
          { ...report().phases[1], status: "running", proposals: [], summary: null },
        ],
      }),
    );
    vi.stubGlobal("fetch", fn);
    render(<TuningDrawer def={def} onClose={() => {}} onApply={async () => {}} />);
    await waitFor(() => expect(screen.getByText(/analyzing phase 2 of 2/i)).toBeTruthy());
    expect(posts).toHaveLength(0);
    expect(screen.getByRole("button", { name: /apply selected/i })).toBeDisabled();
  });

  it("shows proposals per phase, the no-change state, warnings — and never a prompt", async () => {
    const { fn } = tuneFetch(report());
    vi.stubGlobal("fetch", fn);
    const { container } = render(
      <TuningDrawer def={def} onClose={() => {}} onApply={async () => {}} />,
    );
    await waitFor(() => expect(screen.getByText(/no changes recommended/i)).toBeTruthy());
    expect(screen.getByText("haiku")).toBeTruthy();
    expect(screen.getByText(/flagship model is overkill/i)).toBeTruthy();
    expect(screen.getByText(/currently inherited from cli/i)).toBeTruthy();
    expect(screen.getByText(/not a tunable setting/i)).toBeTruthy();
    expect(screen.getByText(/2 proposals across 2 phases/i)).toBeTruthy();
    expect(container.textContent).not.toContain(SECRET_PROMPT);
    expect(container.textContent).not.toContain("Write a plan.");
  });

  it("applies only the ticked proposals through onApply, then closes", async () => {
    const user = userEvent.setup();
    const { fn } = tuneFetch(report());
    vi.stubGlobal("fetch", fn);
    const onApply = vi.fn(async (_input: PipelineInput) => {});
    const onClose = vi.fn();
    render(<TuningDrawer def={def} onClose={onClose} onApply={onApply} />);
    await waitFor(() => expect(screen.getByText(/no changes recommended/i)).toBeTruthy());

    const apply = screen.getByRole("button", { name: /apply selected \(0\)/i });
    expect(apply).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /apply model for draft/i }));
    await user.click(screen.getByRole("button", { name: /apply selected \(1\)/i }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const input = onApply.mock.calls[0][0];
    expect(input.phases[0].steps[0].model).toBe("haiku");
    expect("timeoutSeconds" in input.phases[0].steps[0]).toBe(false);
    expect(input.phases[0].steps[0].prompt).toBe("Write a plan.");
    expect(input.phases[1].steps[0].prompt).toBe(SECRET_PROMPT);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("explains when passes are disabled instead of starting one", async () => {
    const { fn, posts } = tuneFetch(null, "tuning passes are disabled (ARGUS_ANALYSIS=off)");
    vi.stubGlobal("fetch", fn);
    render(<TuningDrawer def={def} onClose={() => {}} onApply={async () => {}} />);
    await waitFor(() => expect(screen.getByText(/disabled/i)).toBeTruthy());
    expect(posts).toHaveLength(0);
  });
});
