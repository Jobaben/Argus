import { describe, it, expect } from "vitest";
import {
  edgeState,
  LANE_GEOMETRY,
  laneLayout,
  laneWidthFor,
  labelWidth,
  type LanePhase,
} from "./laneGraphLayout";
import type { RouteEdgeView } from "../ds";

function phase(
  id: string,
  status: LanePhase["status"] = "idle",
  needs: string[] = [],
  over: Partial<LanePhase> = {},
): LanePhase {
  return { id, status, needs, ...over };
}

const cond = (phase: string, label: string): RouteEdgeView => ({
  phase,
  label,
  conditional: true,
  allowSkipped: false,
});
const plain = (phase: string): RouteEdgeView => ({
  phase,
  label: "always",
  conditional: false,
  allowSkipped: false,
});

const G = LANE_GEOMETRY;
const byId = (layout: ReturnType<typeof laneLayout>, id: string) =>
  layout.nodes.find((n) => n.id === id)!;

describe("laneLayout", () => {
  it("lays a linear pipeline out as one lane, one stage per phase, joined by edges", () => {
    const l = laneLayout([
      phase("a", "done"),
      phase("b", "working", ["a"]),
      phase("c", "idle", ["b"]),
    ]);
    expect(l.lanes).toBe(1);
    expect(l.stages).toBe(3);
    expect(l.nodes.map((n) => [n.id, n.stage, n.lane])).toEqual([
      ["a", 0, 0],
      ["b", 1, 0],
      ["c", 2, 0],
    ]);
    expect(l.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["a>b", "b>c"]);
    // Plain hand-offs use the tight gap.
    expect(byId(l, "b").y - (byId(l, "a").y + G.nodeH)).toBe(G.gapPlain);
    expect(l.width).toBe(G.pad * 2 + G.laneW);
  });

  it("puts a fan-out side by side and hangs the leaf to the right of the chain", () => {
    // `pushback` is a leaf; `plan` continues to `verify`. The chain keeps lane 0
    // regardless of authored order.
    const l = laneLayout([
      phase("read", "done"),
      phase("pushback", "idle", ["read"], { skipped: true }),
      phase("plan", "done", ["read"]),
      phase("verify", "failed", ["plan"]),
    ]);
    expect(byId(l, "plan")).toMatchObject({ stage: 1, lane: 0, leaf: false });
    expect(byId(l, "pushback")).toMatchObject({ stage: 1, lane: 1, leaf: true });
    expect(byId(l, "verify")).toMatchObject({ stage: 2, lane: 0, leaf: true });
    expect(l.lanes).toBe(2);
    expect(l.width).toBe(G.pad * 2 + 2 * G.laneW + G.laneGap);
  });

  it("follows the parents' lanes so a parallel hand-off stays straight", () => {
    const l = laneLayout([
      phase("plan", "done"),
      phase("s-api", "done", ["plan"]),
      phase("s-web", "done", ["plan"]),
      phase("i-api", "done", ["s-api"]),
      phase("i-web", "done", ["s-web"]),
      phase("ship", "idle", ["i-api", "i-web"]),
    ]);
    expect(byId(l, "i-api").lane).toBe(byId(l, "s-api").lane);
    expect(byId(l, "i-web").lane).toBe(byId(l, "s-web").lane);
    // A straight edge is a single line; a join from another lane bends.
    const straight = l.edges.find((e) => e.from === "s-api" && e.to === "i-api")!;
    const bent = l.edges.find((e) => e.from === "i-web" && e.to === "ship")!;
    expect(straight.d).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
    expect(bent.d).toContain("Q");
  });

  it("regression: an instance with no edges at all is ordered, not parallel", () => {
    // Absent edges mean "unknown" (authored before Weave). The chain still
    // draws, through implicit hand-offs, so the board never shows a
    // five-way fan-out for a plain linear pipeline.
    const l = laneLayout([phase("one", "done"), phase("two", "done"), phase("three", "queued")]);
    expect(l.lanes).toBe(1);
    expect(l.stages).toBe(3);
    expect(l.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["one>two", "two>three"]);
    expect(l.edges.map((e) => e.state)).toEqual(["taken", "taken"]);
  });

  it("labels only conditional edges, and gives their stage the wider gap", () => {
    const l = laneLayout([
      phase("read", "done"),
      phase("plan", "done", ["read"], { edges: [cond("read", 'verdict = "ready"')] }),
      phase("verify", "failed", ["plan"], { edges: [plain("plan")] }),
    ]);
    const [toPlan, toVerify] = l.edges;
    expect(toPlan.label?.text).toBe('verdict = "ready"');
    expect(toVerify.label).toBeNull();
    expect(byId(l, "plan").y - (byId(l, "read").y + G.nodeH)).toBe(G.gapLabelled);
    expect(byId(l, "verify").y - (byId(l, "plan").y + G.nodeH)).toBe(G.gapPlain);
    // The label sits centred on the straight line, halfway across the gap.
    expect(toPlan.label?.x).toBe(G.pad + G.laneW / 2);
    expect(toPlan.label?.y).toBe(byId(l, "plan").y - G.gapLabelled / 2);
  });

  it("keeps a straight edge's label on its line and moves the branch label out of its way", () => {
    // Two labels on the same row, wide enough to collide: the one on the
    // vertical run must not drift, or it reads as the neighbour's.
    const l = laneLayout([
      phase("verify", "failed"),
      phase("rejected", "idle", ["verify"], { edges: [cond("verify", 'verdict = "rejected"')] }),
      phase("impl", "idle", ["verify"], { edges: [cond("verify", 'verdict = "approved"')] }),
      phase("test", "idle", ["impl"]),
    ]);
    const straight = l.edges.find((e) => e.to === "impl")!;
    const branch = l.edges.find((e) => e.to === "rejected")!;
    const centre = G.pad + G.laneW / 2;
    expect(straight.label?.x).toBe(centre);
    const gap =
      branch.label!.x -
      labelWidth(branch.label!.text) / 2 -
      (centre + labelWidth(straight.label!.text) / 2);
    expect(gap).toBeGreaterThanOrEqual(6);
  });

  it("reads edge state from both ends", () => {
    expect(edgeState(phase("a", "done"), phase("b", "working"))).toBe("taken");
    expect(edgeState(phase("a", "done"), phase("b", "queued"))).toBe("taken");
    expect(edgeState(phase("a", "done"), phase("b", "idle"))).toBe("pending");
    expect(edgeState(phase("a", "failed"), phase("b", "idle"))).toBe("pending");
    expect(edgeState(phase("a", "done"), phase("b", "idle", [], { skipped: true }))).toBe(
      "skipped",
    );
  });

  it("ignores an edge to a phase that isn't here and handles an empty list", () => {
    const l = laneLayout([phase("a", "done"), phase("b", "idle", ["a", "deleted"])]);
    expect(l.edges).toHaveLength(1);
    expect(laneLayout([])).toMatchObject({ nodes: [], edges: [], lanes: 0, stages: 0 });
  });
});

describe("laneWidthFor", () => {
  it("narrows nodes once three lanes sit side by side", () => {
    expect(laneWidthFor(1)).toBe(G.laneW);
    expect(laneWidthFor(2)).toBe(G.laneW);
    expect(laneWidthFor(3)).toBe(150);
  });

  it("fits the container when that is the tighter limit, never below a readable floor", () => {
    expect(laneWidthFor(2, 1000)).toBe(G.laneW);
    expect(laneWidthFor(2, 358)).toBe(Math.floor((358 - G.pad * 2 - G.laneGap) / 2));
    expect(laneWidthFor(4, 200)).toBe(110);
    // Unmeasured means unknown: use the ideal, not the floor.
    expect(laneWidthFor(2, 0)).toBe(G.laneW);
  });
});
