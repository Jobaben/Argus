import { describe, it, expect } from "vitest";
import {
  activePhases,
  fadeEdges,
  FOLLOW_MARGIN_PX,
  followScroll,
  overflows,
  runwayFor,
  scrollTargetFor,
  type FocusPhase,
} from "./graphFocus";
import { laneLayout } from "./laneGraphLayout";

const p = (id: string, status: FocusPhase["status"], needs: string[] = []): FocusPhase => ({
  id,
  status,
  needs,
});

describe("activePhases", () => {
  it("follows the work, then the gate, then what runs next, then the failure", () => {
    expect(activePhases([p("a", "done"), p("b", "working"), p("c", "working")])).toEqual([
      "b",
      "c",
    ]);
    expect(activePhases([p("a", "await"), p("b", "failed")])).toEqual(["a"]);
    expect(
      activePhases([
        p("a", "done"),
        p("b", "queued", ["x"]),
        p("c", "queued", ["a"]),
        p("x", "idle"),
      ]),
    ).toEqual(["c"]);
    expect(activePhases([p("a", "failed"), p("b", "failed")])).toEqual(["b"]);
    expect(activePhases([p("a", "done")])).toEqual([]);
  });
});

describe("followScroll", () => {
  /**
   * The QA board's "Monorepo nightly": a root, a fan of six checks with three
   * of them running, a join and a routed chain after it, all in lane 0 — at
   * 1280 a 1174px graph in an 872px tile.
   */
  const fanNames: Record<string, string> = {
    checkout: "Check out the monorepo",
    lint: "Lint and format",
    typecheck: "Typecheck all packages",
    unit: "Unit tests",
    integration: "Integration tests",
    e2e: "End-to-end browser tests",
    docs: "Docs link check",
    bundle: "Bundle and sign",
    canary: "Canary deploy",
    rollback: "Roll back",
    publish: "Publish release",
    notify: "Notify the channel",
  };
  const checks = ["lint", "typecheck", "unit", "integration", "e2e", "docs"];
  const needsOf: Record<string, string[]> = {
    checkout: [],
    bundle: checks,
    canary: ["bundle"],
    rollback: ["bundle"],
    publish: ["canary"],
    notify: ["publish", "rollback"],
  };
  const nightly = (working: string[]) =>
    Object.entries(fanNames).map(([id, name]) => ({
      ...p(id, working.includes(id) ? "working" : id === "checkout" ? "done" : "idle"),
      name,
      needs: needsOf[id] ?? ["checkout"],
    }));
  const at1280 = (phases: ReturnType<typeof nightly>) => {
    const layout = laneLayout(phases);
    const scale = 1174 / layout.width;
    const viewport = { w: 872, h: 640 };
    const runway = {
      x: runwayFor(1174, viewport.w, 12 * scale),
      y: runwayFor(layout.height * scale, viewport.h, 12 * scale),
    };
    const target = followScroll(phases, layout, viewport, { scale, runway })!;
    /** Where a phase lands in the tile, in screen pixels. */
    const onScreen = (id: string) => {
      const n = layout.nodes.find((q) => q.id === id)!;
      const left = n.x * scale + runway.x - target.left;
      return { left, right: left + layout.nodeW * scale };
    };
    return { layout, scale, runway, target, onScreen };
  };

  it("scrolls a graph a little wider than its tile no further than it takes to show the work", () => {
    const working = ["typecheck", "unit", "e2e"];
    const { scale, runway, target, onScreen, layout } = at1280(nightly(working));
    // 302px wider than the tile is not much wider: no runway to scroll into.
    expect(runway.x).toBe(0);
    for (const id of working) {
      expect(onScreen(id).left).toBeGreaterThanOrEqual(0);
      expect(onScreen(id).right).toBeLessThanOrEqual(872 - FOLLOW_MARGIN_PX + 0.5);
    }
    // Little more than it takes: within the graph's own 302px of overflow.
    // Centring their middle in a half-tile runway scrolled 577px and left the
    // root, the join and the chain after it mostly out of view.
    expect(target.left).toBeLessThanOrEqual(1174 - 872);
    expect(target.left).toBeLessThan(577);
    expect(layout.width * scale).toBeCloseTo(1174);
  });

  it("stays at the start, root in view, while the work is already in view there", () => {
    const { target, onScreen } = at1280(nightly(["lint", "typecheck"]));
    expect(target).toEqual({ left: 0, top: 0 });
    expect(onScreen("checkout").left).toBeGreaterThanOrEqual(0);
    expect(onScreen("typecheck").right).toBeLessThan(872);
  });

  it("starts where the work starts when it is wider than the tile", () => {
    const { target, onScreen } = at1280(nightly(checks));
    // The first check in view, the root above it; the rest are to the right,
    // where the fade says there is more.
    expect(target.left).toBe(0);
    expect(onScreen("lint").left).toBeGreaterThanOrEqual(0);
    expect(onScreen("docs").right).toBeGreaterThan(872);
  });

  it("centres the running phase of a much wider graph, using the runway at its start", () => {
    const chain = Array.from({ length: 30 }, (_, i) =>
      p(`c${i}`, i === 1 ? "working" : i < 1 ? "done" : "idle", i === 0 ? [] : [`c${i - 1}`]),
    );
    const layout = laneLayout(chain);
    const viewport = { w: 300, h: 300 };
    const runway = { x: 0, y: runwayFor(layout.height, viewport.h, 12) };
    expect(runway.y).toBeGreaterThan(0);
    const frame = { scale: 1, runway };
    /** How far the phase's middle is from the tile's middle. */
    const offCentre = (phases: typeof chain, id: string) => {
      const n = layout.nodes.find((q) => q.id === id)!;
      const { top } = followScroll(phases, layout, viewport, frame)!;
      return n.y + layout.nodeH / 2 + runway.y - top - viewport.h / 2;
    };
    // Near the start the runway above it lets the second phase reach the middle.
    expect(Math.abs(offCentre(chain, "c1"))).toBeLessThanOrEqual(1);
    const later = chain.map((q, i) => ({
      ...q,
      status: i < 20 ? ("done" as const) : i === 20 ? ("working" as const) : ("idle" as const),
    }));
    expect(Math.abs(offCentre(later, "c20"))).toBeLessThanOrEqual(1);
  });

  it("centres phases that fit only without the margin", () => {
    const fan = [
      p("pin", "done"),
      ...Array.from({ length: 3 }, (_, i) => p(`d${i}`, "working", ["pin"])),
    ];
    const layout = laneLayout(fan);
    const nodes = layout.nodes.filter((n) => n.id !== "pin");
    const lo = Math.min(...nodes.map((n) => n.x));
    const hi = Math.max(...nodes.map((n) => n.x)) + layout.nodeW;
    const w = Math.ceil(hi - lo) + 10;
    const { left } = followScroll(
      fan,
      layout,
      { w, h: 1000 },
      { scale: 1, runway: { x: 0, y: 0 } },
    )!;
    // As much room before the first of them as after the last.
    expect(lo - left).toBeCloseTo(left + w - hi, 0);
  });

  it("has nothing to follow on a finished run", () => {
    const done = [p("a", "done")];
    expect(
      followScroll(done, laneLayout(done), { w: 1, h: 1 }, { scale: 1, runway: { x: 0, y: 0 } }),
    ).toBeNull();
  });
});

describe("runwayFor and scrollTargetFor", () => {
  it("lets the first and the last phase reach the centre", () => {
    const pad = 12;
    const content = 2000;
    const viewport = 600;
    const runway = runwayFor(content, viewport, pad);
    expect(runway).toBe(viewport / 2 - pad);
    const frame = { scale: 1, runway: { x: runway, y: 0 } };
    const first = scrollTargetFor({ x: pad, y: 0 }, { w: viewport, h: 0 }, frame);
    expect(first.left).toBe(0);
    const last = scrollTargetFor({ x: content - pad, y: 0 }, { w: viewport, h: 0 }, frame);
    // The far edge of the scroll content is the scaled graph plus both runways.
    expect(last.left + viewport).toBe(content + runway * 2);
  });

  it("adds no runway to an axis that fits, or overflows by less than half a tile", () => {
    expect(runwayFor(500, 600, 12)).toBe(0);
    expect(runwayFor(500, 0, 12)).toBe(0);
    // The 1280 board: 302px over an 872px tile scrolls, and only by that much.
    expect(overflows(1174, 872)).toBe(true);
    expect(runwayFor(1174, 872, 12)).toBe(0);
    // Past half a tile it grows in, so a resize never jolts the graph.
    expect(runwayFor(872 * 1.5 + 40, 872, 12)).toBe(40);
  });

  it("treats a graph scaled to exactly its viewport as fitting", () => {
    // 622 * (432 / 622) is a hair over 432 in floating point.
    const scaled = 622 * (432 / 622);
    expect(overflows(scaled, 432)).toBe(false);
    expect(overflows(433, 432)).toBe(true);
  });

  it("scales the point before centring it", () => {
    expect(
      scrollTargetFor(
        { x: 1000, y: 500 },
        { w: 400, h: 200 },
        { scale: 0.5, runway: { x: 10, y: 0 } },
      ),
    ).toEqual({ left: 310, top: 150 });
  });
});

describe("fadeEdges", () => {
  const m = { scrollWidth: 1000, scrollHeight: 800, clientWidth: 400, clientHeight: 300 };

  it("fades only the edges with more graph beyond them", () => {
    expect(fadeEdges({ ...m, scrollLeft: 0, scrollTop: 0 })).toEqual({
      top: 0,
      left: 0,
      bottom: 24,
      right: 24,
    });
    expect(fadeEdges({ ...m, scrollLeft: 300, scrollTop: 200 })).toEqual({
      top: 24,
      left: 24,
      bottom: 24,
      right: 24,
    });
    expect(fadeEdges({ ...m, scrollLeft: 600, scrollTop: 500 })).toEqual({
      top: 24,
      left: 24,
      bottom: 0,
      right: 0,
    });
  });

  it("does not fade over the empty runway", () => {
    // At the graph's start in a tile with a 100px runway each side.
    const at = { ...m, scrollLeft: 100, scrollTop: 0 };
    expect(fadeEdges(at, { x: 100, y: 0 })).toMatchObject({ left: 0, right: 24 });
    expect(fadeEdges({ ...m, scrollLeft: 500, scrollTop: 0 }, { x: 100, y: 0 }).right).toBe(0);
  });

  it("fades nothing when everything fits", () => {
    expect(
      fadeEdges({
        scrollLeft: 0,
        scrollTop: 0,
        scrollWidth: 300,
        scrollHeight: 200,
        clientWidth: 300,
        clientHeight: 200,
      }),
    ).toEqual({ top: 0, left: 0, bottom: 0, right: 0 });
  });
});
