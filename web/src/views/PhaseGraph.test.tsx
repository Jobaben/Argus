import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PhasePill, StepPill } from "../ds";
import { PhaseGraph } from "./PhaseGraph";
import { BOARD_GAP_PX, boardArrangement, FOCUS_MIN_PX } from "./useLaneLayout";
import { attentionPhase } from "./phaseAttention";
import { MIN_SCALE } from "./laneGraphLayout";

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
    candidate: null,
    verified: null,
    selected: false,
    superseded: false,
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
  const { layout } = boardArrangement(phases, width);
  return <PhaseGraph phases={phases} layout={layout} selectedId={selectedId} onSelect={onSelect} />;
}

const chain = (statuses: PhasePill["status"][]) =>
  statuses.map((st, i) => pill(`p${i}`, st, i === 0 ? {} : { needs: [`p${i - 1}`] }));

const fanOut = (n: number, status: PhasePill["status"] = "working") => [
  pill("pin", "done", { name: "Pin revision and check dependency closure" }),
  ...Array.from({ length: n }, (_, i) =>
    pill(`d${i}`, status, { name: `Discover rules: Bookings area ${i}`, needs: ["pin"] }),
  ),
];

/**
 * jsdom has no layout or scrolling: give every element a measured viewport,
 * taller content when it should overflow, and record what the tile is asked to
 * do.
 */
function mockScrollTo({ overflow = true } = {}) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(overflow ? 1000 : 200);
  const scrollTo = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: scrollTo,
    configurable: true,
    writable: true,
  });
  return scrollTo;
}

afterEach(() => {
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  vi.restoreAllMocks();
});

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

  it("shows the full name on hover and keeps it for tests", () => {
    render(<Graph phases={fanOut(2)} />);
    const node = screen.getByRole("button", { name: /Bookings area 1/ });
    expect(node.title.startsWith("3. Discover rules: Bookings area 1")).toBe(true);
    expect(node.querySelector("[data-full-name]")?.getAttribute("data-full-name")).toBe(
      "Discover rules: Bookings area 1",
    );
  });

  it("scrolls inside a bounded tile instead of sizing it", () => {
    render(<Graph phases={fanOut(8)} width={1100} />);
    const tile = screen.getByTestId("phase-graph");
    expect(tile.className).toContain("overflow-auto");
    expect(tile.style.width).toBe("");
  });

  it("ends each leaf along the direction the graph reads", () => {
    render(<Graph phases={fanOut(8)} width={1100} />);
    expect(screen.getAllByTestId("graph-terminator")).toHaveLength(8);
    const tile = screen.getByTestId("phase-graph");
    expect(tile.closest("[data-orientation]")?.getAttribute("data-orientation")).toBe("LR");
  });
});

describe("boardArrangement", () => {
  it("never lets the graph take the focus panel's room", () => {
    const b = boardArrangement(fanOut(8), 1100);
    expect(b.stacked).toBe(false);
    expect(b.graphTrackPx + BOARD_GAP_PX + FOCUS_MIN_PX).toBeLessThanOrEqual(1100);
  });

  it("turns a wide fan-out sideways on a narrow card, small enough to read", () => {
    const b = boardArrangement(fanOut(50), 358);
    expect(b.stacked).toBe(true);
    expect(b.layout.orientation).toBe("LR");
    expect(b.layout.width * MIN_SCALE).toBeLessThanOrEqual(358);
  });

  it("keeps a plain fork top-down beside the panel", () => {
    const b = boardArrangement(fanOut(2), 1200);
    expect(b.stacked).toBe(false);
    expect(b.layout.orientation).toBe("TB");
    expect(b.graphTrackPx).toBe(b.layout.width + 2);
  });

  it("treats an unmeasured card as unknown, not narrow", () => {
    expect(boardArrangement(fanOut(2), 0).stacked).toBe(false);
  });
});

describe("PhaseGraph: following the run", () => {
  it("centres the running phase by scrolling its own tile, never the page", () => {
    const scrollTo = mockScrollTo();
    const intoView = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<Graph phases={chain(["done", "working", "idle"])} />);
    expect(intoView).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // The first placement jumps rather than animating in.
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ behavior: "auto" });
  });

  it("moves on to the next phase as the run does", () => {
    const scrollTo = mockScrollTo();
    const { rerender } = render(<Graph phases={chain(["done", "working", "idle"])} />);
    const first = scrollTo.mock.calls[0][0];
    rerender(<Graph phases={chain(["done", "done", "working"])} />);
    expect(scrollTo).toHaveBeenCalledTimes(2);
    const next = scrollTo.mock.calls[1][0];
    expect(next.top).toBeGreaterThan(first.top);
    expect(next.behavior).toBe("smooth");
  });

  it("jumps instead of gliding under reduced motion", () => {
    const scrollTo = mockScrollTo();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({ matches: query.includes("reduce") }) as MediaQueryList,
    });
    const { rerender } = render(<Graph phases={chain(["done", "working", "idle"])} />);
    rerender(<Graph phases={chain(["done", "done", "working"])} />);
    expect(scrollTo.mock.calls[1][0]).toMatchObject({ behavior: "auto" });
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("stops following once the user scrolls, until asked to follow again", () => {
    const scrollTo = mockScrollTo();
    const { rerender } = render(<Graph phases={chain(["done", "working", "idle"])} />);
    const tile = screen.getByTestId("phase-graph");
    expect(screen.queryByTestId("graph-follow")).toBeNull();

    fireEvent.wheel(tile);
    expect(tile.dataset.following).toBe("false");
    rerender(<Graph phases={chain(["done", "done", "working"])} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("graph-follow"));
    expect(tile.dataset.following).toBe("true");
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("graph-follow")).toBeNull();
  });

  it("leaves following on when the graph fits and there is nothing to scroll", () => {
    mockScrollTo({ overflow: false });
    render(<Graph phases={chain(["done", "working", "idle"])} />);
    const tile = screen.getByTestId("phase-graph");
    fireEvent.wheel(tile);
    expect(tile.dataset.following).toBe("true");
    expect(screen.queryByTestId("graph-follow")).toBeNull();
  });

  it("centres a phase the board selects itself, such as a gate opening", () => {
    const scrollTo = mockScrollTo();
    const phases = chain(["working", "idle", "idle", "idle"]);
    const { rerender } = render(<Graph phases={phases} selectedId="p0" />);
    const first = scrollTo.mock.calls[scrollTo.mock.calls.length - 1][0];
    const gated = phases.map((p) => (p.id === "p3" ? { ...p, status: "await" as const } : p));
    rerender(<Graph phases={gated} selectedId="p3" />);
    const last = scrollTo.mock.calls[scrollTo.mock.calls.length - 1][0];
    expect(last.top).toBeGreaterThan(first.top);
  });

  it("centres a clicked phase and leaves the view with the user", () => {
    const scrollTo = mockScrollTo();
    const onSelect = vi.fn();
    render(<Graph phases={chain(["done", "working", "idle"])} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /p2/ }));
    expect(onSelect).toHaveBeenCalledWith("p2");
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("phase-graph").dataset.following).toBe("false");
  });

  it("fits a wide graph to its tile and offers full size", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    render(<Graph phases={fanOut(3)} />);
    const canvas = screen.getByTestId("graph-canvas");
    expect(canvas.style.transform).toMatch(/^scale\(/);
    fireEvent.click(screen.getByTestId("graph-zoom"));
    expect(canvas.style.transform).toBe("");
    expect(screen.getByTestId("graph-zoom").textContent).toBe("Fit");
  });
});

describe("PhaseGraph: candidates", () => {
  it("summarises best-of-N in place of the step dots, and names the winner", () => {
    render(
      <Graph
        phases={[
          pill("impl", "working", {
            steps: [step("working"), step("working"), step("working")],
            candidates: { total: 3, verified: 2, selected: 1 },
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("candidate-summary").textContent).toBe("2/3 verified · c2 selected");
  });

  it("says only how many verified while the selection is still open", () => {
    render(
      <Graph
        phases={[
          pill("impl", "working", {
            steps: [step("working"), step("working")],
            candidates: { total: 2, verified: 0, selected: null },
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("candidate-summary").textContent).toBe("0/2 verified");
    // The dots are gone: three tiles of one step would say nothing.
    const node = screen.getByRole("button", { name: /impl/ });
    expect(node.getAttribute("title")).toContain("0/2 verified");
  });

  it("leaves an ordinary phase's step dots alone", () => {
    render(
      <Graph phases={[pill("build", "working", { steps: [step("done"), step("working")] })]} />,
    );
    expect(screen.queryByTestId("candidate-summary")).toBeNull();
  });
});
