import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useFlip } from "./flip";

/**
 * jsdom has no layout, so every `getBoundingClientRect` is zeros and no element
 * ever "moves". The behaviour worth pinning here is therefore the *decision*: what
 * gets animated, what is left alone, and what happens when the list changes faster
 * than the animation — which is exactly where a FLIP implementation goes wrong.
 */

type Rect = { top: number; left: number };

/** Positions each key claims to be at, so a reorder can be simulated. */
function withLayout(positions: Map<string, Rect>) {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const key = this.getAttribute("data-key") ?? "";
    const at = positions.get(key) ?? { top: 0, left: 0 };
    return { ...at, width: 100, height: 20, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
}

function List({ keys }: { keys: string[] }) {
  const flip = useFlip();
  return (
    <ul>
      {keys.map((k) => (
        <li key={k} data-key={k} ref={flip(k)}>
          {k}
        </li>
      ))}
    </ul>
  );
}

const animations: { element: Element; keyframes: unknown }[] = [];

function captureAnimations() {
  animations.length = 0;
  vi.spyOn(Element.prototype, "animate").mockImplementation(function (
    this: Element,
    keyframes: unknown,
  ) {
    animations.push({ element: this, keyframes });
    return { cancel: () => {}, onfinish: null } as unknown as Animation;
  } as typeof Element.prototype.animate);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useFlip", () => {
  it("does not animate a row's first appearance — its own entrance owns that", () => {
    const layout = withLayout(new Map([["a", { top: 0, left: 0 }]]));
    captureAnimations();
    render(<List keys={["a"]} />);
    expect(animations).toHaveLength(0);
    layout.mockRestore();
  });

  it("animates a row from where it was to where it is", () => {
    const positions = new Map<string, Rect>([
      ["a", { top: 0, left: 0 }],
      ["b", { top: 40, left: 0 }],
    ]);
    withLayout(positions);
    captureAnimations();
    const { rerender } = render(<List keys={["a", "b"]} />);
    expect(animations).toHaveLength(0);

    // They swap places.
    positions.set("a", { top: 40, left: 0 });
    positions.set("b", { top: 0, left: 0 });
    rerender(<List keys={["b", "a"]} />);

    expect(animations).toHaveLength(2);
    // `a` was at the top and is now 40px down, so the invert puts it back *up*
    // 40px and animates that offset away. Getting this sign wrong is the classic
    // FLIP bug: the row appears to jump ahead and then slide back.
    expect(animations[0].keyframes).toEqual([
      { transform: "translate(0px, -40px)" },
      { transform: "none" },
    ]);
  });

  it("ignores a sub-pixel wobble, which is a reflow and not a reorder", () => {
    const positions = new Map<string, Rect>([["a", { top: 0, left: 0 }]]);
    withLayout(positions);
    captureAnimations();
    const { rerender } = render(<List keys={["a"]} />);
    positions.set("a", { top: 0.4, left: 0 });
    rerender(<List keys={["a"]} />);
    expect(animations).toHaveLength(0);
  });

  it("snaps rather than animates an absurd jump", () => {
    const positions = new Map<string, Rect>([["a", { top: 0, left: 0 }]]);
    withLayout(positions);
    captureAnimations();
    const { rerender } = render(<List keys={["a"]} />);
    positions.set("a", { top: 99_999, left: 0 });
    rerender(<List keys={["a"]} />);
    expect(animations).toHaveLength(0);
  });

  it("retargets instead of stacking when the list moves faster than it animates", () => {
    const positions = new Map<string, Rect>([["a", { top: 0, left: 0 }]]);
    withLayout(positions);
    const cancelled: number[] = [];
    animations.length = 0;
    vi.spyOn(Element.prototype, "animate").mockImplementation(function (
      this: Element,
      keyframes: unknown,
    ) {
      const index = animations.length;
      animations.push({ element: this, keyframes });
      return {
        cancel: () => cancelled.push(index),
        onfinish: null,
      } as unknown as Animation;
    } as typeof Element.prototype.animate);

    const { rerender } = render(<List keys={["a"]} />);
    positions.set("a", { top: 40, left: 0 });
    rerender(<List keys={["a"]} />);
    positions.set("a", { top: 80, left: 0 });
    rerender(<List keys={["a"]} />);

    expect(animations).toHaveLength(2);
    // The first is cancelled by the second: a board updating every frame must
    // converge on the current layout, not queue every layout it passed through.
    expect(cancelled).toContain(0);
  });

  it("forgets a row that unmounts, so a reused key does not animate from a stale position", () => {
    const positions = new Map<string, Rect>([["a", { top: 0, left: 0 }]]);
    withLayout(positions);
    captureAnimations();
    const { rerender } = render(<List keys={["a"]} />);
    rerender(<List keys={[]} />);
    positions.set("a", { top: 500, left: 0 });
    rerender(<List keys={["a"]} />);
    expect(animations).toHaveLength(0);
  });
});
