/** SVG path data for an orthogonal polyline, its corners rounded by `r`. */
export function roundedOrthogonalPath(
  points: readonly (readonly [number, number])[],
  r = 7,
): string {
  if (points.length < 2) return "";
  const [x0, y0] = points[0];
  let d = `M${x0} ${y0}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    // A corner never eats more than half of either leg, so two corners on a
    // short leg meet in the middle instead of overlapping.
    const inLen = Math.abs(cx - px) + Math.abs(cy - py);
    const outLen = Math.abs(nx - cx) + Math.abs(ny - cy);
    const k = Math.min(r, inLen / 2, outLen / 2);
    const ax = cx - Math.sign(cx - px) * k;
    const ay = cy - Math.sign(cy - py) * k;
    const bx = cx + Math.sign(nx - cx) * k;
    const by = cy + Math.sign(ny - cy) * k;
    d += `L${ax} ${ay}Q${cx} ${cy} ${bx} ${by}`;
  }
  const [xn, yn] = points[points.length - 1];
  return `${d}L${xn} ${yn}`;
}
