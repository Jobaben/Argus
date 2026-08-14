import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PhasePill, StepPill } from "../ds";
import { PhaseRail } from "./PhaseRail";
import { attentionPhase } from "./phaseAttention";

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

describe("PhaseRail", () => {
  it("renders every phase as a chip and reports clicks", () => {
    const onSelect = vi.fn();
    render(
      <PhaseRail
        phases={[pill("plan", "done"), pill("build", "working"), pill("ship", "idle")]}
        selectedId="build"
        onSelect={onSelect}
      />,
    );
    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(3);
    expect(screen.getByRole("button", { name: /build/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /ship/ }));
    expect(onSelect).toHaveBeenCalledWith("ship");
  });

  it("groups phases that can run together into one stage", () => {
    // build-a and build-b both need plan: two stages, the second holding both.
    render(
      <PhaseRail
        phases={[
          pill("plan", "done"),
          pill("build-a", "working", { needs: ["plan"] }),
          pill("build-b", "working", { needs: ["plan"] }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const rail = screen.getByTestId("phase-rail");
    // Top-level list items are stages: 2 stages, not 3.
    const stages = Array.from(rail.children);
    expect(stages).toHaveLength(2);
    expect(stages[1].textContent).toContain("build-a");
    expect(stages[1].textContent).toContain("build-b");
  });

  it("treats an instance without dependency edges as ordered, not parallel", () => {
    // Absent edges mean "unknown" (authored before Weave) — one stage per
    // phase in order, never a single all-parallel stage.
    render(
      <PhaseRail
        phases={[pill("one", "done"), pill("two", "done"), pill("three", "queued")]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const stages = Array.from(screen.getByTestId("phase-rail").children);
    expect(stages).toHaveLength(3);
  });

  it("marks gates, attempts and step progress on the chip", () => {
    render(
      <PhaseRail
        phases={[
          pill("review", "await", {
            gated: true,
            attempt: 1,
            steps: [step("done"), step("done"), step("queued")],
          }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const chip = screen.getByRole("button", { name: /review/ });
    expect(chip.textContent).toContain("gate");
    expect(chip.textContent).toContain("try 2");
    expect(chip.title).toContain("needs approval");
  });

  it("names dependencies in the chip title", () => {
    render(
      <PhaseRail
        phases={[
          pill("plan", "done", { name: "Plan" }),
          pill("build", "working", { name: "Build", needs: ["plan"] }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Build/ }).title).toContain("waits for Plan");
    expect(screen.getByRole("button", { name: /Plan/ }).title).toContain("starts immediately");
  });
});
