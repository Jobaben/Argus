/**
 * Springs, for the two places a curve is not enough.
 *
 * A cubic-bezier with a bump — `--ease-spring` — looks like a spring and is not
 * one: it has no notion of velocity, so nothing can hand momentum to it. Every
 * gesture in the app therefore ended at a dead stop and then started a fresh,
 * fixed-length animation, which is the difference between releasing a physical
 * control and letting go of a picture of one.
 *
 * This module solves that twice over:
 *
 * - {@link springLinear} samples a real damped oscillator into a CSS
 *   `linear()` easing, so a *declarative* animation can have spring shape.
 * - {@link settleDuration} and {@link settleFrom} answer "given that the
 *   pointer was moving this fast when it let go, where does this thing come to
 *   rest, and how long does that take?" — which is what makes a flick feel like
 *   a flick rather than a click with extra steps.
 */

export interface SpringSpec {
  /** How hard the spring pulls toward the target. Higher = snappier. */
  stiffness: number;
  /** How hard the medium resists. Higher = less overshoot. */
  damping: number;
  mass: number;
}

/**
 * The one spring in the system.
 *
 * ζ = damping / (2·√(stiffness·mass)) ≈ 0.78 — under-damped, so it overshoots
 * once by ~9% and settles. Anything much livelier reads as a toy; anything
 * flatter is just `--ease-out-expo` with extra maths.
 */
export const SPRING: SpringSpec = { stiffness: 280, damping: 26, mass: 1 };

/**
 * Normalised spring position at `t` seconds, travelling 0 → 1.
 *
 * The closed-form solution of a damped harmonic oscillator released from rest,
 * so this is the same curve a physics-based animator would integrate — just
 * evaluated rather than stepped, which is what lets it be sampled ahead of time.
 */
export function springValue(t: number, spec: SpringSpec = SPRING): number {
  const { stiffness, damping, mass } = spec;
  const omega0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    return (
      1 -
      Math.exp(-zeta * omega0 * t) *
        (Math.cos(omegaD * t) + ((zeta * omega0) / omegaD) * Math.sin(omegaD * t))
    );
  }
  // Critically damped: no overshoot, and the under-damped form divides by zero.
  return 1 - Math.exp(-omega0 * t) * (1 + omega0 * t);
}

/**
 * How long the spring takes to be visually done, in milliseconds.
 *
 * "Done" is the envelope decaying to 0.2% rather than the analytic infinity:
 * past that the movement is sub-pixel and holding an animation open for it only
 * costs interruptibility. Stopping *earlier* than this is the tempting mistake —
 * the curve is still 1.5% past its target at the 1% mark, so a shorter sampling
 * window bakes a visible overshoot into the easing's final value.
 */
export function springDurationMs(spec: SpringSpec = SPRING): number {
  const omega0 = Math.sqrt(spec.stiffness / spec.mass);
  const zeta = spec.damping / (2 * Math.sqrt(spec.stiffness * spec.mass));
  return Math.round((-Math.log(0.002) / (zeta * omega0)) * 1000);
}

/**
 * The spring as a CSS `linear()` easing string.
 *
 * `linear()` is how a spring gets into a stylesheet at all: it is a piecewise
 * approximation, so the sampling density is the fidelity knob. 25 stops is the
 * point where the overshoot is smooth and the declaration is still legible;
 * fewer and the peak visibly corners.
 *
 * Percentages are emitted for every stop but the first and last so the string
 * survives being read by a human diffing it against `index.css` — which
 * `spring.test.ts` does, to keep the token and this generator from drifting.
 */
export function springLinear(spec: SpringSpec = SPRING, stops = 25): string {
  const durationS = springDurationMs(spec) / 1000;
  const points: string[] = [];
  for (let i = 0; i < stops; i++) {
    const progress = i / (stops - 1);
    const value = round(springValue(progress * durationS, spec));
    if (i === 0) points.push("0");
    // The last stop is pinned to 1 rather than sampled. The sample is within
    // 0.3% of it, and an easing that ends at 1.003 leaves whatever it drove
    // three thousandths past its target for as long as the fill holds.
    else if (i === stops - 1) points.push("1 100%");
    else points.push(`${value} ${round(progress * 100, 2)}%`);
  }
  return `linear(${points.join(", ")})`;
}

function round(n: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

/**
 * Where a flick comes to rest, and how long it glides to get there.
 *
 * Exponential decay of the release velocity, which is the standard scroll-style
 * model and — more usefully — the one whose *distance* is a closed form, so a
 * gesture can decide up front whether the flick clears a dismissal threshold
 * instead of animating first and asking afterwards.
 *
 * @param velocity px/ms at release (sign preserved)
 * @param decay fraction of velocity retained per ms
 */
export function settleFrom(velocity: number, decay = 0.995): { distance: number; ms: number } {
  // Below this the pointer was effectively parked; a glide would be a twitch.
  if (Math.abs(velocity) < 0.02) return { distance: 0, ms: 0 };
  const perMs = -Math.log(decay);
  // ∫v·e^(-kt)dt from 0 to ∞
  const distance = velocity / perMs;
  return { distance, ms: settleDuration(velocity, decay) };
}

/** How long the glide above lasts before its remaining travel is sub-pixel. */
export function settleDuration(velocity: number, decay = 0.995): number {
  const speed = Math.abs(velocity);
  if (speed < 0.02) return 0;
  const perMs = -Math.log(decay);
  // Solve |v|·e^(-kt)/k = 0.5px for t: the point where half a pixel is left.
  const ms = Math.log(speed / (0.5 * perMs)) / perMs;
  return Math.max(0, Math.min(600, Math.round(ms)));
}
