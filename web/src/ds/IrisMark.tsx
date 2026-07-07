import { useEffect, useRef } from "react";

// Tracked agents the eye is monitoring — angle, orbit radius (×R), status color
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
    // Spec constants are authored on a 124px canvas; scale for arbitrary sizes.
    const px = W / 124;
    const TAU = Math.PI * 2;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let t = 0;
    let lookX = 0;
    let lookY = 0;

    function draw(ctx: CanvasRenderingContext2D) {
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 3 * px;
      ctx.strokeStyle = "rgba(54,227,232,0.85)";
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = "rgba(54,227,232,0.30)";
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.74, 0, TAU);
      ctx.stroke();
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, R * 0.6);
      g.addColorStop(0, "rgba(54,227,232,0.55)");
      g.addColorStop(0.55, "rgba(54,227,232,0.10)");
      g.addColorStop(1, "rgba(54,227,232,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.6, 0, TAU);
      ctx.fill();

      const sweep = (((t * 1.4) % TAU) + TAU) % TAU;
      let topLit = 0;
      let topAngle: number | null = null;

      // Tracked-agent blips: flare as the sweep passes, then fade over the rotation
      for (const ag of AGENTS) {
        const ax = cx + Math.cos(ag.a) * R * ag.r;
        const ay = cy + Math.sin(ag.a) * R * ag.r;
        let lit;
        if (reduce) {
          lit = 0.6;
        } else {
          const delta = (sweep - ag.a + TAU) % TAU;
          lit = Math.pow(1 - delta / TAU, 3);
          lit = 0.18 + lit * 0.82;
        }
        // Eye glances at the freshest detection
        if (lit > topLit) {
          topLit = lit;
          topAngle = ag.a;
        }
        // Detection ring expands right after the pass
        if (!reduce && lit > 0.55) {
          const ring = (lit - 0.55) / 0.45;
          ctx.strokeStyle = `rgba(${ag.c},${(0.5 * (1 - ring)).toFixed(3)})`;
          ctx.lineWidth = 1.5 * px;
          ctx.beginPath();
          ctx.arc(ax, ay, (2 + ring * 7) * px, 0, TAU);
          ctx.stroke();
        }
        ctx.fillStyle = `rgba(${ag.c},${lit.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(ax, ay, 2.6 * px, 0, TAU);
        ctx.fill();
        const gg = ctx.createRadialGradient(ax, ay, 0, ax, ay, 7 * px);
        gg.addColorStop(0, `rgba(${ag.c},${(lit * 0.55).toFixed(3)})`);
        gg.addColorStop(1, `rgba(${ag.c},0)`);
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(ax, ay, 7 * px, 0, TAU);
        ctx.fill();
      }

      // The white stays centered; only the iris/pupil glances toward the freshest detection
      let tgX = 0;
      let tgY = 0;
      if (!reduce && topAngle !== null) {
        tgX = Math.cos(topAngle) * R * 0.085;
        tgY = Math.sin(topAngle) * R * 0.085;
      }
      lookX += (tgX - lookX) * 0.1;
      lookY += (tgY - lookY) * 0.1;
      ctx.fillStyle = "#eaf2fb";
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.2, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#0a0f16";
      ctx.beginPath();
      ctx.arc(cx + lookX, cy + lookY, R * 0.12, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(54,227,232,0.9)";
      ctx.beginPath();
      ctx.arc(cx + lookX + R * 0.04, cy + lookY - R * 0.04, R * 0.025, 0, TAU);
      ctx.fill();

      if (!reduce) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(sweep);
        const lg = ctx.createLinearGradient(0, 0, R, 0);
        lg.addColorStop(0, "rgba(54,227,232,0)");
        lg.addColorStop(1, "rgba(54,227,232,0.6)");
        ctx.strokeStyle = lg;
        ctx.lineWidth = 2 * px;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(R * 0.95, 0);
        ctx.stroke();
        ctx.restore();
      }
      t += 0.016;
    }

    if (reduce) {
      draw(ctx);
      return;
    }
    let raf = 0;
    const loop = () => {
      draw(ctx);
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
