import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PhasePill } from "../ds";
import { PhaseGraph } from "./PhaseGraph";

const phase = (id: string, over: Partial<PhasePill> = {}): PhasePill => ({
  id,
  name: id,
  status: "idle",
  activeStep: null,
  steps: [],
  reason: null,
  gated: false,
  needs: [],
  attempt: 0,
  retryAt: null,
  ...over,
});

describe("PhaseGraph", () => {
  it("draws a diamond as three stages", () => {
    render(
      <PhaseGraph
        phases={[
          phase("plan", { status: "done" }),
          phase("build", { needs: ["plan"], status: "working" }),
          phase("test", { needs: ["plan"], status: "working" }),
          phase("ship", { needs: ["build", "test"] }),
        ]}
      />,
    );
    expect(screen.getByText(/3 stages, 4 dependencies/)).toBeInTheDocument();
    expect(screen.getByText("ship")).toBeInTheDocument();
    // Each phase says what it waits for, in text — the graph degrades to prose
    // rather than to nothing for a screen reader.
    expect(screen.getByText("← build, test")).toBeInTheDocument();
  });

  it("renders nothing for a linear pipeline", () => {
    const { container } = render(
      <PhaseGraph phases={[phase("a"), phase("b", { needs: ["a"] })]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("regression: renders nothing when the instance carries no edges at all", () => {
    const { container } = render(<PhaseGraph phases={[phase("a"), phase("b"), phase("c")]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("marks a gate, a retried attempt and a queued retry", () => {
    render(
      <PhaseGraph
        phases={[
          phase("plan"),
          phase("build", {
            needs: ["plan"],
            attempt: 2,
            status: "failed",
            retryAt: "2026-07-20T12:00:00.000Z",
          }),
          phase("review", { needs: ["plan"], gated: true, status: "await" }),
        ]}
      />,
    );
    expect(screen.getByText("gate")).toBeInTheDocument();
    expect(screen.getByText("attempt 3")).toBeInTheDocument();
    expect(screen.getByText("retry queued")).toBeInTheDocument();
  });

  it("a queued retry only shows on a failed phase", () => {
    render(
      <PhaseGraph
        phases={[
          phase("plan"),
          phase("build", {
            needs: ["plan"],
            status: "working",
            retryAt: "2026-07-20T12:00:00.000Z",
          }),
          phase("test", { needs: ["plan"] }),
        ]}
      />,
    );
    expect(screen.queryByText("retry queued")).not.toBeInTheDocument();
  });
});
