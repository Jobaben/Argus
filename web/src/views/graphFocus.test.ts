import { describe, it, expect } from "vitest";
import {
  activePhases,
  fadeEdges,
  followTarget,
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

describe("followTarget", () => {
  const fan = [
    p("pin", "done"),
    ...Array.from({ length: 8 }, (_, i) => p(`d${i}`, "working", ["pin"])),
  ];
  const layout = laneLayout(fan, { orientation: "LR" });
  const node = (id: string) => layout.nodes.find((n) => n.id === id)!;

  it("centres one running phase", () => {
    const one = [p("a", "done"), p("b", "working", ["a"])];
    const l = laneLayout(one);
    const b = l.nodes.find((n) => n.id === "b")!;
    expect(followTarget(one, l, { w: 1000, h: 1000 })).toEqual({
      x: b.x + l.nodeW / 2,
      y: b.y + l.nodeH / 2,
    });
  });

  it("centres the middle of parallel phases that fit together", () => {
    const t = followTarget(fan, layout, { w: 2000, h: 2000 })!;
    expect(t.y).toBe((node("d0").y + node("d7").y + layout.nodeH) / 2);
  });

  it("starts with the first of them when they don't fit together", () => {
    const t = followTarget(fan, layout, { w: 300, h: 100 })!;
    const first = layout.nodes.filter((n) => n.id !== "pin").sort((a, b) => a.lane - b.lane)[0];
    expect(t).toEqual({ x: first.x + layout.nodeW / 2, y: first.y + layout.nodeH / 2 });
  });

  it("has nothing to follow on a finished run", () => {
    expect(followTarget([p("a", "done")], laneLayout([p("a", "done")]), { w: 1, h: 1 })).toBeNull();
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

  it("adds no runway to an axis that fits", () => {
    expect(runwayFor(500, 600, 12)).toBe(0);
    expect(runwayFor(500, 0, 12)).toBe(0);
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
