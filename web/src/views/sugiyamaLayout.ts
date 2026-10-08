import type { DagEdge, DagLayout, DagLayoutEngine, DagNode } from "./dagLayout";

/**
 * A layered (Sugiyama) layout: ranks by longest path, a slot per node and per
 * rank an edge skips over, barycentric crossing reduction, orthogonal routing
 * through the gaps between ranks.
 *
 * Built for "any shape, never broken" rather than for the most compact
 * picture. Every node gets a slot of the same size, so a rank is a grid row and
 * an edge that skips ranks runs down a slot of its own — it can never cut
 * through a node. Duplicate ids, dependencies on phases that aren't there,
 * self-loops and cycles are tolerated and reported, not thrown.
 *
 * Deterministic: every tie is broken by input order, so the same pipeline
 * draws the same way on every poll.
 */

interface Vertex {
  key: string;
  real: boolean;
  rank: number;
  /** Size along the slot axis (TB: width) and the rank axis (TB: height). */
  s: number;
  r: number;
  gapBefore: number;
  /** Tie-break: input index for nodes, after every node for edge slots. */
  tie: number;
  hasDown: boolean;
}

type Link = { from: string; to: string };
type Point = [number, number];

const SWEEPS = ["down", "up", "down", "up"] as const;

function crossings(upper: string[], lower: string[], down: Map<string, string[]>): number {
  const pos = new Map(lower.map((k, i) => [k, i]));
  const segs: [number, number][] = [];
  upper.forEach((k, i) => {
    for (const d of down.get(k) ?? []) segs.push([i, pos.get(d) ?? 0]);
  });
  let n = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = [segs[i], segs[j]];
      if ((a[0] - b[0]) * (a[1] - b[1]) < 0) n++;
    }
  }
  return n;
}

function totalCrossings(layers: string[][], down: Map<string, string[]>): number {
  let n = 0;
  for (let r = 0; r + 1 < layers.length; r++) n += crossings(layers[r], layers[r + 1], down);
  return n;
}

/** Drop repeated points and the middle of any three in a straight line. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    const prev = out[out.length - 2];
    if (
      prev &&
      last &&
      ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))
    ) {
      out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  return out;
}

export const sugiyamaLayout: DagLayoutEngine = (input, options) => {
  const { orientation, rankGap, nodeGap, pad, tail } = options;
  const tb = orientation === "TB";
  const dropped: DagLayout["dropped"] = { danglingDeps: [], cycleEdges: [] };

  // 1. Normalize.
  const seen = new Set<string>();
  const nodes = input.nodes.filter((n) => !seen.has(n.id) && seen.add(n.id));
  if (nodes.length === 0) {
    return { orientation, width: pad * 2, height: pad * 2, nodes: [], edges: [], dropped };
  }
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const links: Link[] = [];
  for (const n of nodes) {
    for (const d of new Set(n.deps)) {
      if (d === n.id) dropped.cycleEdges.push({ from: d, to: d });
      else if (!index.has(d)) dropped.danglingDeps.push({ from: d, to: n.id });
      else links.push({ from: d, to: n.id });
    }
  }

  // 2. Break cycles: a depth-first walk in input order reverses every back edge.
  const outOf = new Map<string, number[]>(nodes.map((n) => [n.id, []]));
  links.forEach((l, i) => outOf.get(l.from)!.push(i));
  const reversed = new Set<number>();
  const visit = new Map<string, "open" | "done">();
  for (const root of nodes) {
    if (visit.has(root.id)) continue;
    visit.set(root.id, "open");
    const stack = [{ id: root.id, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const outs = outOf.get(top.id)!;
      if (top.next < outs.length) {
        const li = outs[top.next++];
        const to = links[li].to;
        const state = visit.get(to);
        if (state === "open") reversed.add(li);
        else if (state === undefined) {
          visit.set(to, "open");
          stack.push({ id: to, next: 0 });
        }
      } else {
        visit.set(top.id, "done");
        stack.pop();
      }
    }
  }
  [...reversed].sort((a, b) => a - b).forEach((li) => dropped.cycleEdges.push(links[li]));
  const flow: Link[] = links.map((l, i) => (reversed.has(i) ? { from: l.to, to: l.from } : l));

  // 3. Ranks: longest path from the roots, in topological order.
  const preds = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const succs = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const l of flow) {
    preds.get(l.to)!.push(l.from);
    succs.get(l.from)!.push(l.to);
  }
  const indeg = new Map(nodes.map((n) => [n.id, preds.get(n.id)!.length]));
  const order = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const rank = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    rank.set(id, Math.max(0, ...preds.get(id)!.map((p) => rank.get(p)! + 1)));
    for (const s of succs.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) order.push(s);
    }
  }

  // 4. A vertex per node, and one per rank an edge passes through.
  const vertices = new Map<string, Vertex>();
  nodes.forEach((n, i) => {
    vertices.set(n.id, {
      key: n.id,
      real: true,
      rank: rank.get(n.id)!,
      s: tb ? n.w : n.h,
      r: tb ? n.h : n.w,
      gapBefore: n.gapBefore ?? 0,
      tie: i,
      hasDown: succs.get(n.id)!.length > 0,
    });
  });
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    down.set(a, [...(down.get(a) ?? []), b]);
    up.set(b, [...(up.get(b) ?? []), a]);
  };
  const chains = flow.map((l, li) => {
    const chain = [l.from];
    for (let r = rank.get(l.from)! + 1; r < rank.get(l.to)!; r++) {
      const key = `\u0000${li}:${r}`;
      vertices.set(key, {
        key,
        real: false,
        rank: r,
        s: 0,
        r: 0,
        gapBefore: 0,
        tie: nodes.length + li,
        hasDown: true,
      });
      chain.push(key);
    }
    chain.push(l.to);
    for (let i = 1; i < chain.length; i++) link(chain[i - 1], chain[i]);
    return chain;
  });
  const v = (key: string) => vertices.get(key)!;

  // 5. Order each rank. Seed: phases the chain continues through first, then
  // under their parents, then input order — so the mainline stays left. Then
  // barycentric sweeps, keeping whichever ordering crosses least.
  const rankCount = Math.max(...[...rank.values()]) + 1;
  let layers: string[][] = Array.from({ length: rankCount }, () => []);
  for (const vx of vertices.values()) layers[vx.rank].push(vx.key);
  const posIn = (layer: string[]) => new Map(layer.map((k, i) => [k, i]));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  for (let r = 0; r < rankCount; r++) {
    const above = r > 0 ? posIn(layers[r - 1]) : new Map<string, number>();
    const key = (k: string): [number, number, number] => {
      const ps = (up.get(k) ?? []).map((p) => above.get(p) ?? 0);
      return [v(k).hasDown ? 0 : 1, ps.length > 0 ? mean(ps) : 0, v(k).tie];
    };
    layers[r] = layers[r]
      .map((k) => ({ k, s: key(k) }))
      .sort((a, b) => a.s[0] - b.s[0] || a.s[1] - b.s[1] || a.s[2] - b.s[2])
      .map((e) => e.k);
  }
  let best = layers.map((l) => [...l]);
  let bestCrossings = totalCrossings(layers, down);
  for (const dir of SWEEPS) {
    if (bestCrossings === 0) break;
    const ranks =
      dir === "down"
        ? Array.from({ length: rankCount - 1 }, (_, i) => i + 1)
        : Array.from({ length: rankCount - 1 }, (_, i) => rankCount - 2 - i);
    for (const r of ranks) {
      const ref = posIn(layers[dir === "down" ? r - 1 : r + 1]);
      const neighbours = dir === "down" ? up : down;
      layers[r] = layers[r]
        .map((k, i) => {
          const ps = (neighbours.get(k) ?? []).map((n) => ref.get(n) ?? 0);
          return { k, i, bary: ps.length > 0 ? mean(ps) : i };
        })
        .sort((a, b) => a.bary - b.bary || a.i - b.i)
        .map((e) => e.k);
    }
    const n = totalCrossings(layers, down);
    if (n < bestCrossings) {
      bestCrossings = n;
      best = layers.map((l) => [...l]);
    }
  }
  layers = best;

  // 6. Coordinates, in slot/rank space first and mapped to x/y at the end.
  const slot = Math.max(...nodes.map((n) => v(n.id).s));
  const extent = layers.map((l) => Math.max(0, ...l.map((k) => v(k).r)));
  const rankStart: number[] = [];
  const gapOf: number[] = [];
  let cursor = pad;
  layers.forEach((l, r) => {
    const gap = r === 0 ? 0 : Math.max(rankGap, ...l.map((k) => v(k).gapBefore));
    gapOf.push(gap);
    cursor += gap;
    rankStart.push(cursor);
    cursor += extent[r];
  });
  const slots = Math.max(...layers.map((l) => l.length));
  const slotAxis = pad * 2 + slots * slot + (slots - 1) * nodeGap;
  const rankAxis = cursor + tail + pad;
  const slotOf = new Map<string, number>();
  layers.forEach((l) => l.forEach((k, i) => slotOf.set(k, i)));
  const centreS = (k: string) => pad + slotOf.get(k)! * (slot + nodeGap) + slot / 2;
  const nearR = (k: string) => rankStart[v(k).rank] + (extent[v(k).rank] - v(k).r) / 2;
  const toXY = ([s, r]: Point): Point => (tb ? [s, r] : [r, s]);

  const leaves = new Set(nodes.map((n) => n.id));
  for (const l of links) leaves.delete(l.from);
  const placed: DagNode[] = nodes.map((n) => {
    const vx = v(n.id);
    const [x, y] = toXY([centreS(n.id) - vx.s / 2, nearR(n.id)]);
    return {
      id: n.id,
      rank: vx.rank,
      order: slotOf.get(n.id)!,
      x,
      y,
      w: n.w,
      h: n.h,
      leaf: leaves.has(n.id),
    };
  });

  // 7. Route: down from the source, across the middle of each gap, down
  // through each skipped rank's slot, into the target.
  const edges: DagEdge[] = flow.map((_, li) => {
    const chain = chains[li];
    const head = chain[0];
    const pts: Point[] = [[centreS(head), nearR(head) + v(head).r]];
    let anchor: Point = [0, 0];
    let straight = true;
    for (let j = 1; j < chain.length; j++) {
      const k = chain[j];
      const r = v(k).rank;
      const mid = rankStart[r] - gapOf[r] / 2;
      const from = centreS(chain[j - 1]);
      const to = centreS(k);
      pts.push([from, mid], [to, mid]);
      if (v(k).real) {
        pts.push([to, nearR(k)]);
        straight = from === to;
        anchor = [straight ? to : (from + to) / 2, mid];
      } else {
        pts.push([to, rankStart[r]], [to, rankStart[r] + extent[r]]);
      }
    }
    const points = simplify(pts).map(toXY);
    const isReversed = reversed.has(li);
    const [ax, ay] = toXY(anchor);
    return {
      from: links[li].from,
      to: links[li].to,
      points: isReversed ? points.reverse() : points,
      reversed: isReversed,
      anchor: { x: ax, y: ay, straight },
    };
  });

  return {
    orientation,
    width: tb ? slotAxis : rankAxis,
    height: tb ? rankAxis : slotAxis,
    nodes: placed,
    edges,
    dropped,
  };
};
