import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import type { PhasePill, StepPill } from "../ds";
import type { SpawnTaskState } from "../types";
import { PhaseGraph } from "./PhaseGraph";
import { phaseLayout } from "./useLaneLayout";
import { RETURN_AFTER_MS } from "./useGraphFocus";
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

/** Renders the graph the way the board does: layout from the hook. */
function Graph({
  phases,
  selectedId = null,
  onSelect = () => {},
}: {
  phases: PhasePill[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const layout = phaseLayout(phases);
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
 * wider content when it should overflow, and record what the tile is asked to
 * do.
 */
function mockScrollTo({ overflow = true } = {}) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(overflow ? 1000 : 300);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
  const scrollTo = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: scrollTo,
    configurable: true,
    writable: true,
  });
  return scrollTo;
}

/** Presses, moves the pointer far enough to pan, and lets go. */
function drag(el: HTMLElement, dx = 40, dy = 0) {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
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
    expect(skipped).toHaveTextContent("Skipped");
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
    // Sentence case, like every other label: small, not shouted or lowercased.
    expect(node).toHaveTextContent("Gate");
    expect(node).toHaveTextContent("Try 2");
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
    render(<Graph phases={fanOut(8)} />);
    const tile = screen.getByTestId("phase-graph");
    expect(tile.className).toContain("overflow-hidden");
    expect(tile.style.width).toBe("");
  });

  it("ends each leaf along the direction the graph reads", () => {
    render(<Graph phases={fanOut(8)} />);
    expect(screen.getAllByTestId("graph-terminator")).toHaveLength(8);
    const tile = screen.getByTestId("phase-graph");
    expect(tile.closest("[data-orientation]")?.getAttribute("data-orientation")).toBe("LR");
  });
});

describe("phaseLayout", () => {
  it("always lays the graph out left to right", () => {
    for (const phases of [chain(["working"]), fanOut(2), fanOut(50)]) {
      expect(phaseLayout(phases).orientation).toBe("LR");
    }
  });
});

describe("PhaseGraph: following the run", () => {
  /** A chain long enough to scroll its tile, running phase `at`. */
  const runAt = (at: number) =>
    chain(Array.from({ length: 30 }, (_, i) => (i < at ? "done" : i === at ? "working" : "idle")));

  it("brings the running phase into view by scrolling its own tile, never the page", () => {
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
    const { rerender } = render(<Graph phases={runAt(1)} />);
    const first = scrollTo.mock.calls[0][0];
    // Far enough down the chain to be out of view where it started.
    rerender(<Graph phases={runAt(20)} />);
    expect(scrollTo).toHaveBeenCalledTimes(2);
    const next = scrollTo.mock.calls[1][0];
    expect(next.left).toBeGreaterThan(first.left);
    expect(next.behavior).toBe("smooth");
  });

  it("jumps instead of gliding under reduced motion", () => {
    const scrollTo = mockScrollTo();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({ matches: query.includes("reduce") }) as MediaQueryList,
    });
    const { rerender } = render(<Graph phases={runAt(1)} />);
    rerender(<Graph phases={runAt(20)} />);
    expect(scrollTo.mock.calls[1][0]).toMatchObject({ behavior: "auto" });
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("looks away on a drag, and the Follow button brings the view back at once", () => {
    const scrollTo = mockScrollTo();
    // Long enough to scroll its tile, so there is a view to take over.
    const { rerender } = render(<Graph phases={runAt(1)} />);
    const tile = screen.getByTestId("phase-graph");
    const follow = screen.getByRole("button", { name: "Follow" });

    drag(tile);
    expect(tile.dataset.following).toBe("false");
    // Following is still switched on: the drag only looked away.
    expect(follow).toHaveAttribute("aria-pressed", "true");
    rerender(<Graph phases={runAt(2)} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    fireEvent.click(follow);
    expect(tile.dataset.following).toBe("true");
    expect(scrollTo).toHaveBeenCalledTimes(2);
    // Still there, pressed, under the focus that pressed it.
    expect(follow).toBeInTheDocument();
    expect(follow).toHaveAttribute("aria-pressed", "true");
  });

  describe("returning to the run", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

    it("goes back to the run once the pointer has been off the graph a while", () => {
      const scrollTo = mockScrollTo();
      render(<Graph phases={runAt(1)} />);
      const tile = screen.getByTestId("phase-graph");
      const well = tile.closest<HTMLElement>("[data-orientation]")!;
      fireEvent.pointerEnter(well);
      drag(tile);
      fireEvent.pointerLeave(well);
      wait(RETURN_AFTER_MS - 1);
      expect(tile.dataset.following).toBe("false");
      wait(1);
      expect(tile.dataset.following).toBe("true");
      expect(scrollTo).toHaveBeenCalledTimes(2);
    });

    it("never moves the view while the pointer is still over the graph", () => {
      mockScrollTo();
      render(<Graph phases={runAt(1)} />);
      const tile = screen.getByTestId("phase-graph");
      const well = tile.closest<HTMLElement>("[data-orientation]")!;
      drag(tile);
      wait(RETURN_AFTER_MS * 2);
      expect(tile.dataset.following).toBe("false");
      // Leaving and coming back before the countdown ends cancels it.
      fireEvent.pointerLeave(well);
      wait(RETURN_AFTER_MS / 2);
      fireEvent.pointerEnter(well);
      wait(RETURN_AFTER_MS * 2);
      expect(tile.dataset.following).toBe("false");
    });

    it("leaves the view where the user put it with following switched off", () => {
      mockScrollTo();
      render(<Graph phases={runAt(1)} />);
      const tile = screen.getByTestId("phase-graph");
      const well = tile.closest<HTMLElement>("[data-orientation]")!;
      fireEvent.click(screen.getByRole("button", { name: "Follow" }));
      drag(tile);
      fireEvent.pointerLeave(well);
      wait(RETURN_AFTER_MS * 2);
      expect(tile.dataset.following).toBe("false");
    });
  });

  it("leaves the view to following when the board's pick moves on with the run", () => {
    const scrollTo = mockScrollTo();
    const { rerender } = render(<Graph phases={runAt(1)} selectedId="p1" />);
    rerender(<Graph phases={runAt(20)} selectedId="p20" />);
    // Following's move alone: centring the pick on top of it undid the follow.
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo.mock.calls[1][0]).toMatchObject({ behavior: "smooth" });
    // Not following, the board's pick is still brought to the middle.
    drag(screen.getByTestId("phase-graph"));
    rerender(<Graph phases={runAt(25)} selectedId="p25" />);
    expect(scrollTo).toHaveBeenCalledTimes(3);
    expect(scrollTo.mock.calls[2][0].left).toBeGreaterThan(scrollTo.mock.calls[1][0].left);
  });

  it("opens a run with nothing to follow at the graph's start, not on the runway before it", () => {
    const scrollTo = mockScrollTo();
    render(<Graph phases={chain(Array.from({ length: 30 }, () => "done" as const))} />);
    const start = parseFloat(screen.getByTestId("graph-canvas").style.left);
    expect(start).toBeGreaterThan(0);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ left: Math.round(start), behavior: "auto" });
  });

  it("leaves following on when the graph fits and there is nothing to scroll", () => {
    mockScrollTo({ overflow: false });
    render(<Graph phases={chain(["working"])} />);
    const tile = screen.getByTestId("phase-graph");
    drag(tile);
    expect(tile.dataset.following).toBe("true");
    expect(screen.queryByTestId("graph-follow")).toBeNull();
  });

  it("ignores the wheel: it neither moves the view nor stops following", () => {
    mockScrollTo();
    render(<Graph phases={runAt(1)} />);
    const tile = screen.getByTestId("phase-graph");
    expect(tile.className).toContain("overflow-hidden");
    fireEvent.wheel(tile, { deltaY: 200 });
    expect(tile.dataset.following).toBe("true");
  });

  it("pans in both directions by dragging", () => {
    mockScrollTo();
    render(<Graph phases={runAt(1)} />);
    const tile = screen.getByTestId("phase-graph");
    tile.scrollLeft = 200;
    tile.scrollTop = 50;
    drag(tile, -30, -20);
    expect(tile.scrollLeft).toBe(230);
    expect(tile.scrollTop).toBe(70);
  });

  it("leaves a press that does not travel as a click on the node", () => {
    mockScrollTo();
    const onSelect = vi.fn();
    render(<Graph phases={chain(["done", "working", "idle"])} onSelect={onSelect} />);
    const node = screen.getByRole("button", { name: /p2/ });
    drag(node, 2, 1);
    fireEvent.click(node);
    expect(onSelect).toHaveBeenCalledWith("p2");
  });

  it("does not select the node a drag ends over", () => {
    mockScrollTo();
    const onSelect = vi.fn();
    render(<Graph phases={chain(["done", "working", "idle"])} onSelect={onSelect} />);
    const node = screen.getByRole("button", { name: /p2/ });
    drag(node);
    fireEvent.click(node);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("centres a phase the board selects itself, such as a gate opening", () => {
    const scrollTo = mockScrollTo();
    const phases = chain(["working", "idle", "idle", "idle"]);
    const { rerender } = render(<Graph phases={phases} selectedId="p0" />);
    const first = scrollTo.mock.calls[scrollTo.mock.calls.length - 1][0];
    const gated = phases.map((p) => (p.id === "p3" ? { ...p, status: "await" as const } : p));
    rerender(<Graph phases={gated} selectedId="p3" />);
    const last = scrollTo.mock.calls[scrollTo.mock.calls.length - 1][0];
    expect(last.left).toBeGreaterThan(first.left);
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

  it("fits a wide graph to its tile, no smaller than readable, and offers full size", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    render(<Graph phases={fanOut(3)} />);
    const canvas = screen.getByTestId("graph-canvas");
    // Far too wide for 300px: held at the floor, and scrolled from there.
    expect(canvas.style.transform).toBe(`scale(${MIN_SCALE})`);
    const zoom = screen.getByRole("button", { name: "Full size" });
    fireEvent.click(zoom);
    expect(canvas.style.transform).toBe("");
    expect(zoom).toHaveAccessibleName("Fit");
  });

  it("keeps its controls in a row of their own, never over the graph", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    render(<Graph phases={fanOut(3)} />);
    const graph = screen.getByTestId("phase-graph");
    for (const control of [screen.getByTestId("graph-zoom"), screen.getByTestId("graph-follow")]) {
      expect(graph).not.toContainElement(control);
      expect(
        control.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(control.parentElement!.className).not.toMatch(/absolute/);
    }
  });

  it("offers following as a toggle wherever the graph scrolls", () => {
    mockScrollTo();
    // A chain long enough to scroll its tile: following is on, and says so.
    render(<Graph phases={chain(Array.from({ length: 30 }, () => "idle" as const))} />);
    const follow = screen.getByRole("button", { name: "Follow" });
    expect(follow).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(follow);
    expect(follow).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("phase-graph").dataset.following).toBe("false");
    fireEvent.click(follow);
    expect(follow).toHaveAttribute("aria-pressed", "true");
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

describe("PhaseGraph: spawn phases", () => {
  const tasks = (...states: SpawnTaskState[]) =>
    states.map((state, i) => ({ key: `t${i}`, state }));
  const spawnPill = (list: ReturnType<typeof tasks>, over: Partial<PhasePill["spawn"]> = {}) =>
    pill("tasks", "working", {
      steps: [],
      spawn: {
        pipelineId: "child",
        tasks: list,
        succeeded: list.filter((t) => t.state === "succeeded").length,
        waiting: 0,
        halted: 0,
        ...over,
      },
    });

  it("draws the spawn glyph and how many tasks are done", () => {
    const list = tasks("succeeded", "succeeded", "running", "pending", "pending");
    render(<Graph phases={[spawnPill(list)]} />);
    const summary = screen.getByTestId("spawn-summary");
    expect(summary.textContent).toBe("2/5");
    expect(summary.querySelector("svg")).not.toBeNull();
    expect(summary.className).toContain("text-ink-faint");
    const node = screen.getByRole("button", { name: /tasks/ });
    expect(node.getAttribute("title")).toContain("2/5 tasks done");
  });

  it("turns violet while a child waits for you, red while a task failed", () => {
    const { unmount } = render(
      <Graph
        phases={[
          spawnPill(tasks("succeeded", "awaiting-approval", "failed"), { waiting: 1, halted: 1 }),
        ]}
      />,
    );
    expect(screen.getByTestId("spawn-summary").className).toContain("text-await");
    const title = screen.getByRole("button", { name: /tasks/ }).getAttribute("title");
    expect(title).toContain("1 waiting for you");
    expect(title).toContain("1 failed or stopped");
    unmount();
    render(<Graph phases={[spawnPill(tasks("failed", "blocked"), { halted: 1 })]} />);
    expect(screen.getByTestId("spawn-summary").className).toContain("text-fail");
  });

  it("draws the glyph alone before the task list is built", () => {
    render(<Graph phases={[spawnPill([])]} />);
    expect(screen.getByTestId("spawn-summary").textContent).toBe("");
    expect(screen.getByRole("button", { name: /tasks/ }).getAttribute("title")).toContain(
      "spawns one child instance per task",
    );
  });

  it("draws no glyph on an ordinary phase", () => {
    render(<Graph phases={[pill("build", "working")]} />);
    expect(screen.queryByTestId("spawn-summary")).toBeNull();
  });
});
