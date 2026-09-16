import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, renderHook } from "@testing-library/react";
import type { PhasePill, StepPill } from "../ds";
import { PhaseGraph } from "./PhaseGraph";
import { useLaneLayout } from "./useLaneLayout";
import { attentionPhase } from "./phaseAttention";
import { LANE_GEOMETRY } from "./laneGraphLayout";

function step(status: StepPill["status"]): StepPill {
  return {
    name: "s",
    runId: null,
    status,
    costUsd: null,
    tokens: null,
    model: null,
    runtime: null,
    currentActivity: null,
    startedAt: null,
    durationMs: null,
  };
}

function pill(id: string, status: PhasePill["status"], over: Partial<PhasePill> = {}): PhasePill {
  return {
    id,
    name: id,
    status,
    activeStep: null,
    steps: [step(status === "working" ? "working" : "queued")],
    reason: null,
    gated: false,
    needs: [],
    attempt: 0,
    retryAt: null,
    ...over,
  };
}

/** Renders the graph the way the board does: layout from the hook, unmeasured card. */
function Graph({
  phases,
  selectedId = null,
  onSelect = () => {},
  width = 0,
}: {
  phases: PhasePill[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  width?: number;
}) {
  const { layout, laneW, stacked } = useLaneLayout(phases, width);
  return (
    <PhaseGraph
      phases={phases}
      layout={layout}
      laneW={laneW}
      stacked={stacked}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
}

describe("attentionPhase", () => {
  it("prefers a gate over a failure over live work", () => {
    expect(attentionPhase([pill("a", "working"), pill("b", "failed"), pill("c", "await")])).toBe(
      "c",
    );
    expect(attentionPhase([pill("a", "working"), pill("b", "failed")])).toBe("b");
    expect(attentionPhase([pill("a", "done"), pill("b", "working")])).toBe("b");
  });

  it("falls back to the next phase still to run, or the last when all ran", () => {
    expect(attentionPhase([pill("a", "done"), pill("b", "queued"), pill("c", "idle")])).toBe("b");
    expect(attentionPhase([pill("a", "done"), pill("b", "done")])).toBe("b");
    expect(attentionPhase([])).toBeNull();
  });
});

describe("PhaseGraph", () => {
  it("renders every phase as a node and reports clicks", () => {
    const onSelect = vi.fn();
    render(
      <Graph
        phases={[pill("plan", "done"), pill("build", "working"), pill("ship", "idle")]}
        selectedId="build"
        onSelect={onSelect}
      />,
    );
    const nodes = screen.getAllByRole("button");
    expect(nodes).toHaveLength(3);
    expect(screen.getByRole("button", { name: /build/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /ship/ }));
    expect(onSelect).toHaveBeenCalledWith("ship");
  });

  it("puts phases that can run together on one row, in separate lanes", () => {
    // build-a and build-b both need plan: two stages, the second holding both.
    render(
      <Graph
        phases={[
          pill("plan", "done"),
          pill("build-a", "working", { needs: ["plan"] }),
          pill("build-b", "working", { needs: ["plan"] }),
        ]}
      />,
    );
    const a = screen.getByRole("button", { name: /build-a/ });
    const b = screen.getByRole("button", { name: /build-b/ });
    expect(a.dataset.stage).toBe("1");
    expect(b.dataset.stage).toBe("1");
    expect(a.dataset.lane).not.toBe(b.dataset.lane);
    expect(screen.getByRole("button", { name: /plan/ }).dataset.stage).toBe("0");
  });

  it("draws one edge per dependency and treats an instance without edges as ordered", () => {
    // Absent edges mean "unknown" (authored before Weave) — one stage per
    // phase in order, joined by the implicit chain, never one parallel stage.
    render(<Graph phases={[pill("one", "done"), pill("two", "done"), pill("three", "queued")]} />);
    const stages = screen.getAllByRole("button").map((b) => b.dataset.stage);
    expect(stages).toEqual(["0", "1", "2"]);
    expect(screen.getAllByTestId("graph-edge")).toHaveLength(2);
  });

  it("labels a conditional edge with its value and reads the path that ran", () => {
    render(
      <Graph
        phases={[
          pill("read", "done"),
          pill("pushback", "idle", {
            needs: ["read"],
            skipped: true,
            edges: [
              {
                phase: "read",
                label: 'verdict = "not ready"',
                conditional: true,
                allowSkipped: false,
              },
            ],
          }),
          pill("plan", "done", {
            needs: ["read"],
            edges: [
              { phase: "read", label: 'verdict = "ready"', conditional: true, allowSkipped: false },
            ],
          }),
          pill("verify", "failed", {
            needs: ["plan"],
            edges: [{ phase: "plan", label: "always", conditional: false, allowSkipped: false }],
          }),
        ]}
      />,
    );
    // Two conditions, one plain hand-off: two labels, and the condition text
    // is no longer inside the node.
    const labels = screen.getAllByTestId("route-label").map((l) => l.textContent);
    expect(labels).toEqual(expect.arrayContaining(['verdict = "ready"', 'verdict = "not ready"']));
    expect(labels).toHaveLength(2);
    expect(screen.getByRole("button", { name: /plan/ }).textContent).not.toContain("if ");
    const states = screen.getAllByTestId("graph-edge").map((e) => e.dataset.state);
    expect(states.filter((s) => s === "taken")).toHaveLength(2);
    expect(states.filter((s) => s === "skipped")).toHaveLength(1);
    // The skipped node says so in words and hollows its dot.
    const skipped = screen.getByRole("button", { name: /pushback/ });
    expect(skipped.textContent).toContain("skip");
  });

  it("marks gates, attempts and step progress on the node", () => {
    render(
      <Graph
        phases={[
          pill("review", "await", {
            gated: true,
            attempt: 1,
            steps: [step("done"), step("done"), step("queued")],
          }),
        ]}
      />,
    );
    const node = screen.getByRole("button", { name: /review/ });
    expect(node.textContent).toContain("gate");
    expect(node.textContent).toContain("try 2");
    expect(node.title).toContain("needs approval");
  });

  it("names dependencies in the node title", () => {
    render(
      <Graph
        phases={[
          pill("plan", "done", { name: "Plan" }),
          pill("build", "working", { name: "Build", needs: ["plan"] }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /Build/ }).title).toContain("waits for Plan");
    expect(screen.getByRole("button", { name: /Plan/ }).title).toContain("starts immediately");
  });

  it("stacks above the focus panel on a narrow card and fits its lanes to it", () => {
    const phases = [
      pill("plan", "done"),
      pill("a", "working", { needs: ["plan"] }),
      pill("b", "working", { needs: ["plan"] }),
    ];
    const wide = renderHook(() => useLaneLayout(phases, 1200)).result.current;
    expect(wide.stacked).toBe(false);
    expect(wide.laneW).toBe(LANE_GEOMETRY.laneW);
    const narrow = renderHook(() => useLaneLayout(phases, 358)).result.current;
    expect(narrow.stacked).toBe(true);
    expect(narrow.layout.width).toBeLessThanOrEqual(358);
    // Unmeasured means unknown, not narrow.
    expect(renderHook(() => useLaneLayout(phases, 0)).result.current.stacked).toBe(false);
  });
});
