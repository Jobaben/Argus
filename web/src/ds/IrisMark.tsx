import { useEffect, useRef } from "react";

const AGENTS = [
  { a: 0.5, r: 0.86, c: "54,227,232" },
  { a: 1.55, r: 0.62, c: "54,227,232" },
  { a: 2.4, r: 0.9, c: "255,178,36" },
  { a: 3.3, r: 0.7, c: "54,227,232" },
  { a: 4.2, r: 0.88, c: "255,87,101" },
  { a: 5.25, r: 0.58, c: "47,230,164" },
];

export function IrisMark({ size = 28 }: { size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.width;
    const H = cv.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = W * 0.46;
    const TAU = Math.PI * 2;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    function draw(ctx: CanvasRenderingContext2D, t: number) {
      ctx.clearRect(0, 0, W, H);
      // outer ring
      ctx.strokeStyle = "rgba(54,227,232,0.55)";
      ctx.lineWidth = Math.max(1, W * 0.03);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      // pupil
      ctx.fillStyle = "#36e3e8";
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.22, 0, TAU);
      ctx.fill();
      // orbiting tracked agents
      for (const g of AGENTS) {
        const ang = g.a + (reduce ? 0 : t * 0.0006);
        const x = cx + Math.cos(ang) * R * g.r;
        const y = cy + Math.sin(ang) * R * g.r;
        ctx.fillStyle = `rgb(${g.c})`;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.2, W * 0.045), 0, TAU);
        ctx.fill();
      }
    }

    if (reduce) {
      draw(ctx, 0);
      return;
    }
    let raf = 0;
    let start = 0;
    const loop = (ts: number) => {
      if (!start) start = ts;
      draw(ctx, ts - start);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden="true"
    />
  );
}
