import { describe, it, expect } from "vitest";
import type { DagInput, DagLayout, DagOptions, Orientation } from "./dagLayout";
import { sugiyamaLayout } from "./sugiyamaLayout";

const W = 160;
const H = 30;

function opts(orientation: Orientation): DagOptions {
  return { orientation, rankGap: 22, nodeGap: 20, pad: 12, tail: 10 };
}

function graph(spec: Record<string, string[]>): DagInput {
  return { nodes: Object.entries(spec).map(([id, deps]) => ({ id, deps, w: W, h: H })) };
}

const onBorder = ([x, y]: [number, number], n: DagLayout["nodes"][number]) => {
  const inX = x >= n.x && x <= n.x + n.w;
  const inY = y >= n.y && y <= n.y + n.h;
  return (inX && (y === n.y || y === n.y + n.h)) || (inY && (x === n.x || x === n.x + n.w));
};

/**
 * What must hold for every shape, in both orientations. Violations are
 * collected and asserted once, so a 300-node graph is not 300k assertions.
 */
function assertInvariants(input: DagInput, layout: DagLayout) {
  const problems: string[] = [];
  const fail = (msg: string) => problems.push(msg);
  const ids = [...new Set(input.nodes.map((n) => n.id))];
  expect(layout.nodes.map((n) => n.id).sort()).toEqual([...ids].sort());

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  for (let i = 0; i < layout.nodes.length; i++) {
    const a = layout.nodes[i];
    if (a.x < 0 || a.y < 0 || a.x + a.w > layout.width || a.y + a.h > layout.height) {
      fail(`${a.id} out of bounds`);
    }
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const b = layout.nodes[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      if (!apart) fail(`${a.id} overlaps ${b.id}`);
    }
  }

  for (const e of layout.edges) {
    const name = `${e.from}>${e.to}`;
    const from = byId.get(e.from)!;
    const to = byId.get(e.to)!;
    if (e.points.length < 2) fail(`${name} has under two points`);
    if (!onBorder(e.points[0], from)) fail(`${name} does not leave its source`);
    if (!onBorder(e.points[e.points.length - 1], to)) fail(`${name} does not reach its target`);
    if (!e.reversed && to.rank <= from.rank) fail(`${name} runs against the ranks`);
    for (const [x, y] of e.points) {
      if (x < 0 || y < 0 || x > layout.width || y > layout.height)
        fail(`${name} leaves the bounds`);
    }
    // Orthogonal, and never through a node other than its own two ends.
    for (let i = 1; i < e.points.length; i++) {
      const [x1, y1] = e.points[i - 1];
      const [x2, y2] = e.points[i];
      if (x1 !== x2 && y1 !== y2) fail(`${name} has a diagonal`);
      for (const n of layout.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        const hitsX = Math.max(x1, x2) > n.x && Math.min(x1, x2) < n.x + n.w;
        const hitsY = Math.max(y1, y2) > n.y && Math.min(y1, y2) < n.y + n.h;
        if (hitsX && hitsY) fail(`${name} crosses ${n.id}`);
      }
    }
  }
  expect(problems).toEqual([]);
  expect(sugiyamaLayout(input, opts(layout.orientation))).toEqual(layout);
}

/** A seeded generator, so the random DAG is the same on every run. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function randomDag(n: number, seed: number): DagInput {
  const next = rng(seed);
  const spec: Record<string, string[]> = {};
  for (let i = 0; i < n; i++) {
    const deps: string[] = [];
    for (let k = 0; k < 3 && i > 0; k++) {
      if (next() < 0.6) deps.push(`n${Math.floor(next() * i)}`);
    }
    spec[`n${i}`] = deps;
  }
  return graph(spec);
}

const fan = (n: number) =>
  graph(
    Object.fromEntries([["root", []], ...Array.from({ length: n }, (_, i) => [`c${i}`, ["root"]])]),
  );

const SHAPES: [string, DagInput][] = [
  ["a single node", graph({ a: [] })],
  [
    "a chain of 20",
    graph(
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, i ? [`p${i - 1}`] : []])),
    ),
  ],
  ["a fan-out of 8", fan(8)],
  ["a fan-out of 50", fan(50)],
  [
    "a fan-in of 8",
    graph({
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`s${i}`, []])),
      join: Array.from({ length: 8 }, (_, i) => `s${i}`),
    }),
  ],
  ["a diamond", graph({ a: [], b: ["a"], c: ["a"], d: ["b", "c"] })],
  ["three separate roots", graph({ x: [], y: [], z: [], w: ["x"] })],
  ["an edge that skips a rank", graph({ a: [], b: ["a"], c: ["b", "a"] })],
  ["a cycle", graph({ a: ["b"], b: ["a"] })],
  ["a self-loop", graph({ a: ["a"], b: ["a"] })],
  ["a dependency that isn't there", graph({ a: [], b: ["a", "gone"] })],
  [
    "a duplicated id",
    { nodes: [...graph({ a: [], b: ["a"] }).nodes, { id: "a", deps: ["b"], w: W, h: H }] },
  ],
  ["a random DAG of 300", randomDag(300, 7)],
];

describe("sugiyamaLayout invariants", () => {
  for (const orientation of ["TB", "LR"] as const) {
    for (const [name, input] of SHAPES) {
      it(`${name} (${orientation})`, () => {
        assertInvariants(input, sugiyamaLayout(input, opts(orientation)));
      });
    }
  }
});

describe("sugiyamaLayout", () => {
  it("lays out nothing as an empty padded box", () => {
    expect(sugiyamaLayout({ nodes: [] }, opts("TB"))).toMatchObject({
      width: 24,
      height: 24,
      nodes: [],
      edges: [],
    });
  });

  it("ranks by longest path and keeps the continuing chain in the first slot", () => {
    const l = sugiyamaLayout(
      graph({ read: [], leaf: ["read"], plan: ["read"], ship: ["plan"] }),
      opts("TB"),
    );
    const n = (id: string) => l.nodes.find((x) => x.id === id)!;
    expect([n("read").rank, n("plan").rank, n("leaf").rank, n("ship").rank]).toEqual([0, 1, 1, 2]);
    expect(n("plan").order).toBe(0);
    expect(n("leaf").order).toBe(1);
    expect(n("leaf").leaf).toBe(true);
    expect(n("plan").leaf).toBe(false);
  });

  it("routes a rank-skipping edge through a slot of its own", () => {
    const l = sugiyamaLayout(graph({ a: [], b: ["a"], c: ["b", "a"] }), opts("TB"));
    const skip = l.edges.find((e) => e.from === "a" && e.to === "c")!;
    const b = l.nodes.find((x) => x.id === "b")!;
    // A vertical run beside b spans b's whole rank.
    const beside = skip.points.some(([x, y], i) => {
      const next = skip.points[i + 1];
      return (
        next !== undefined &&
        next[0] === x &&
        x > b.x + b.w &&
        Math.min(y, next[1]) <= b.y &&
        Math.max(y, next[1]) >= b.y + b.h
      );
    });
    expect(beside).toBe(true);
  });

  it("reports what it had to drop or turn around", () => {
    const cyc = sugiyamaLayout(graph({ a: ["b"], b: ["a"], c: ["c", "gone"] }), opts("TB"));
    expect(cyc.dropped.cycleEdges).toEqual(
      expect.arrayContaining([
        { from: "c", to: "c" },
        { from: "b", to: "a" },
      ]),
    );
    expect(cyc.dropped.danglingDeps).toEqual([{ from: "gone", to: "c" }]);
    expect(cyc.edges.filter((e) => e.reversed)).toHaveLength(1);
  });

  it("uncrosses edges wired across", () => {
    const l = sugiyamaLayout(graph({ p: [], q: [], c: ["q"], d: ["p"] }), opts("TB"));
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x;
    expect(Math.sign(x("p") - x("q"))).toBe(Math.sign(x("d") - x("c")));
  });

  it("opens the gap in front of a rank that asks for more room", () => {
    const input: DagInput = {
      nodes: [
        { id: "a", deps: [], w: W, h: H },
        { id: "b", deps: ["a"], w: W, h: H, gapBefore: 40 },
      ],
    };
    const l = sugiyamaLayout(input, opts("TB"));
    const [a, b] = l.nodes;
    expect(b.y - (a.y + a.h)).toBe(40);
    expect(l.edges[0].anchor).toEqual({ x: a.x + W / 2, y: b.y - 20, straight: true });
  });
});
