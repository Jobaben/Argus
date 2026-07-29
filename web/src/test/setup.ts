import "@testing-library/jest-dom/vitest";

// jsdom implements layout as a no-op, so it ships no `scrollIntoView`. Every
// real browser has had it for a decade, and keeping the product code free of
// `?.` guards for an environment gap is worth one line here.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* layout is not simulated in jsdom */
  };
}

/**
 * A minimal Web Animations API, for the same reason.
 *
 * jsdom has no `Element.animate`, and the motion layer (`ds/presence.ts`,
 * `ds/flip.ts`) is built on it deliberately: WAAPI is the only way to ask an
 * in-flight animation where it currently is, which is what lets a dismissal
 * reverse mid-flight instead of restarting. Without a stub the product code
 * would take its "no WAAPI" fallback in every test, so the exit path — the whole
 * point of that code — would never be exercised.
 *
 * This is a *timing* stub, not a rendering one: it does not interpolate styles
 * (jsdom has no layout to show them in), but it advances `currentTime` in real
 * milliseconds and fires `onfinish` after the requested duration, which is
 * exactly the surface the motion layer reads. Tests therefore assert on what the
 * animation *does* — when the surface unmounts, how far along it was when
 * interrupted — rather than on pixels jsdom could not produce anyway.
 */
if (!Element.prototype.animate) {
  class StubAnimation {
    playState: AnimationPlayState = "running";
    onfinish: ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null = null;
    oncancel: ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null = null;
    readonly finished: Promise<StubAnimation>;

    #startedAt = Date.now();
    #seek = 0;
    #duration: number;
    #timer: ReturnType<typeof setTimeout>;
    #settle!: () => void;

    constructor(duration: number) {
      this.#duration = duration;
      this.finished = new Promise((resolve) => {
        this.#settle = () => resolve(this);
      });
      this.#timer = setTimeout(() => this.finish(), duration);
    }

    /** Elapsed wall-clock since the last seek, clamped to the duration. */
    get currentTime(): number {
      if (this.playState === "finished") return this.#duration;
      return Math.min(this.#duration, this.#seek + (Date.now() - this.#startedAt));
    }

    set currentTime(value: number) {
      this.#seek = value;
      this.#startedAt = Date.now();
      clearTimeout(this.#timer);
      const remaining = Math.max(0, this.#duration - value);
      this.#timer = setTimeout(() => this.finish(), remaining);
    }

    finish(): void {
      if (this.playState !== "running") return;
      clearTimeout(this.#timer);
      this.playState = "finished";
      this.onfinish?.call(this as unknown as Animation, {} as AnimationPlaybackEvent);
      this.#settle();
    }

    cancel(): void {
      clearTimeout(this.#timer);
      if (this.playState === "running") {
        this.playState = "idle";
        this.oncancel?.call(this as unknown as Animation, {} as AnimationPlaybackEvent);
      }
      this.#settle();
    }
  }

  Element.prototype.animate = function animate(
    _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ): Animation {
    const duration = typeof options === "number" ? options : Number(options?.duration ?? 0) || 0;
    return new StubAnimation(duration) as unknown as Animation;
  };
}
