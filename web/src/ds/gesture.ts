import { settleDuration, settleFrom } from "./spring";

/**
 * Pointer velocity, measured rather than guessed.
 *
 * A gesture that ends at a dead stop and hands a fixed-duration animation the
 * baton is the difference between letting go of a physical control and letting go
 * of a picture of one. To hand *momentum* over, something has to know how fast
 * the pointer was moving at the moment it left — and the last two events are the
 * wrong answer: pointer streams are jittery and a single 2ms gap between samples
 * turns a slow drag into a flick.
 *
 * So: a short trailing window, and the velocity across it. Long enough to be
 * stable, short enough that a pause before release reads as a stop — which it
 * should, because it is one.
 */

/** Samples older than this are history, not momentum. */
const WINDOW_MS = 90;

export interface VelocityTracker {
  /** Record a pointer position. `at` is a `performance.now()`-style timestamp. */
  sample: (position: number, at: number) => void;
  /** Signed px/ms across the trailing window; 0 when the pointer was parked. */
  velocity: () => number;
  reset: () => void;
}

export function createVelocityTracker(windowMs = WINDOW_MS): VelocityTracker {
  let samples: { position: number; at: number }[] = [];
  return {
    sample(position, at) {
      samples.push({ position, at });
      // Keep one sample older than the window so a slow drag still has a base
      // to measure from instead of collapsing to a single point.
      const cutoff = at - windowMs;
      let firstInWindow = 0;
      while (firstInWindow < samples.length - 1 && samples[firstInWindow + 1].at < cutoff) {
        firstInWindow++;
      }
      samples = samples.slice(firstInWindow);
    },
    velocity() {
      if (samples.length < 2) return 0;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.at - first.at;
      if (dt <= 0) return 0;
      return (last.position - first.position) / dt;
    },
    reset() {
      samples = [];
    },
  };
}

export interface FlickOutcome {
  /** True when the gesture should complete rather than snap back. */
  release: boolean;
  /** How long the follow-through animation should last, in ms. */
  ms: number;
}

/**
 * Should this gesture complete, and how fast?
 *
 * Two ways to dismiss something, and both have to work, because they are two
 * different intentions. *Dragging past the threshold* is "I have moved this far,
 * finish the job" — a deliberate, slow gesture. A *flick* is "go", stated as
 * velocity, and it must work from two pixels in: waiting for the threshold would
 * make a fast gesture feel ignored, which is the specific failure that makes
 * touch UI feel cheap.
 *
 * @param offset how far the surface has been dragged, px
 * @param velocity release velocity in the dismissing direction, px/ms
 * @param size the surface's extent along the axis, px
 */
export function flickOutcome(offset: number, velocity: number, size: number): FlickOutcome {
  const past = size > 0 && offset > size * 0.3;
  const flicked = velocity > 0.35;
  if (!past && !flicked) {
    // Snap back at spring speed; the distance is short and the point is that it
    // refuses, visibly, rather than just stopping.
    return { release: false, ms: settleDuration(Math.max(0.4, Math.abs(velocity))) };
  }
  const remaining = Math.max(0, size - offset);
  // A flick leaves at flick speed. A drag past the threshold has no velocity to
  // inherit, so it gets the spring's own settle time.
  const glide = settleFrom(Math.max(velocity, 0.4));
  const ms = glide.ms > 0 ? Math.min(glide.ms, msFor(remaining, Math.max(velocity, 0.4))) : 120;
  return { release: true, ms: Math.max(80, Math.round(ms)) };
}

function msFor(distance: number, velocity: number): number {
  return distance / velocity;
}
