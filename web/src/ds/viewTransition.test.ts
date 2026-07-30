import { describe, it, expect, vi, afterEach } from "vitest";
import {
  setRouteDirection,
  startViewTransition,
  supportsViewTransitions,
  transitionName,
} from "./viewTransition";

const original = document.startViewTransition;

function stubMatchMedia(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  document.startViewTransition = original;
  stubMatchMedia(false);
  delete document.documentElement.dataset.route;
});

describe("supportsViewTransitions", () => {
  it("is false in jsdom, which is the same answer Firefox and Safari give", () => {
    expect(supportsViewTransitions()).toBe(false);
  });
});

describe("startViewTransition", () => {
  it("still applies the update when the browser has no view transitions", () => {
    const update = vi.fn();
    startViewTransition(update);
    expect(update).toHaveBeenCalledOnce();
  });

  it("wraps the update when the browser does have them", () => {
    const wrapped: (() => void)[] = [];
    document.startViewTransition = ((cb: () => void) => {
      wrapped.push(cb);
      cb();
      return { finished: Promise.resolve() };
    }) as unknown as typeof document.startViewTransition;

    const update = vi.fn();
    startViewTransition(update);
    expect(wrapped).toHaveLength(1);
    expect(update).toHaveBeenCalledOnce();
  });

  it("refuses to start one under reduced motion — the `*` rule in index.css cannot reach ::view-transition-*", () => {
    stubMatchMedia(true);
    const start = vi.fn();
    document.startViewTransition = start as unknown as typeof document.startViewTransition;
    const update = vi.fn();
    startViewTransition(update);
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });

  it("navigates anyway if starting a transition throws", () => {
    document.startViewTransition = (() => {
      throw new Error("a transition is already in flight");
    }) as unknown as typeof document.startViewTransition;
    const update = vi.fn();
    startViewTransition(update);
    expect(update).toHaveBeenCalledOnce();
  });
});

describe("setRouteDirection", () => {
  it("publishes the direction for the stylesheet to select on", () => {
    setRouteDirection("forward");
    expect(document.documentElement.dataset.route).toBe("forward");
  });
});

describe("transitionName", () => {
  it("builds a custom-ident from a kind and an id", () => {
    expect(transitionName("agent", "abc123")).toBe("agent-abc123");
  });

  it("sanitises anything a custom-ident cannot hold", () => {
    expect(transitionName("agent", "a/b c.d")).toBe("agent-a-b-c-d");
  });

  it("declines rather than emitting an invalid name", () => {
    expect(transitionName("agent", null)).toBeUndefined();
    expect(transitionName("agent", "")).toBeUndefined();
    expect(transitionName("agent", "///")).toBeUndefined();
  });
});
