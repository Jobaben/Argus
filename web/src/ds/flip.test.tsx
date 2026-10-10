import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useFlip } from "./flip";

/**
 * jsdom has no layout, so every offset is zero and no element ever "moves". The
 * behaviour worth pinning here is therefore the *decision*: what gets animated,
 * what is left alone, and what happens when the list changes faster than the
 * animation — which is exactly where a FLIP implementation goes wrong.
 */

type Rect = { top: number; left: number };

/**
 * Positions each key claims to be laid out at, so a reorder can be simulated.
 *
 * Mocks the offset chain, not `getBoundingClientRect`: the hook deliberately
 * reads layout offsets so that scroll and in-flight transforms cannot register
 * as moves. `offsetParent` is null so each row is its own chain.
 */
function withLayout(positions: Map<string, Rect>) {
  const at = function (this: HTMLElement) {
    return positions.get(this.getAttribute("data-key") ?? "") ?? { top: 0, left: 0 };
  };
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return at.call(this).top;
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return at.call(this).left;
  });
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(null);
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
const cancelled: number[] = [];

function captureAnimations() {
  animations.length = 0;
  cancelled.length = 0;
  vi.spyOn(Element.prototype, "animate").mockImplementation(function (
    this: Element,
    keyframes: unknown,
  ) {
    const index = animations.length;
    animations.push({ element: this, keyframes });
    return { cancel: () => cancelled.push(index), onfinish: null } as unknown as Animation;
  } as typeof Element.prototype.animate);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useFlip", () => {
  it("does not animate a row's first appearance — its own entrance owns that", () => {
    withLayout(new Map([["a", { top: 0, left: 0 }]]));
    captureAnimations();
    render(<List keys={["a"]} />);
    expect(animations).toHaveLength(0);
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

  it("ignores a one-pixel wobble, which is a reflow and not a reorder", () => {
    const positions = new Map<string, Rect>([["a", { top: 0, left: 0 }]]);
    withLayout(positions);
    captureAnimations();
    const { rerender } = render(<List keys={["a"]} />);
    positions.set("a", { top: 1, left: 0 });
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

  it("measures layout, so a scroll between renders moves nothing", () => {
    // The layout offsets are unchanged; only the viewport moved. A hook reading
    // client rects would see every row shifted by the scroll distance here.
    const positions = new Map<string, Rect>([
      ["a", { top: 0, left: 0 }],
      ["b", { top: 40, left: 0 }],
    ]);
    withLayout(positions);
    captureAnimations();
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const { rerender } = render(<List keys={["a", "b"]} />);
    window.scrollY = 300;
    rerender(<List keys={["a", "b"]} />);
    rerender(<List keys={["a", "b"]} />);
    expect(animations).toHaveLength(0);
    expect(rect).not.toHaveBeenCalled();
  });

  it("leaves a running glide alone when a re-render moved nothing", () => {
    const positions = new Map<string, Rect>([["a", { top: 0, left: 0 }]]);
    withLayout(positions);
    captureAnimations();
    const { rerender } = render(<List keys={["a"]} />);
    positions.set("a", { top: 40, left: 0 });
    rerender(<List keys={["a"]} />);
    expect(animations).toHaveLength(1);

    // The board re-renders mid-glide (a tick, an activity frame). The row is
    // still drawn part-way along its translation, but its layout has not moved.
    rerender(<List keys={["a"]} />);
    rerender(<List keys={["a"]} />);
    expect(animations).toHaveLength(1);
    expect(cancelled).toHaveLength(0);
  });

  it("retargets instead of stacking when the list moves faster than it animates", () => {
    const positions = new Map<string, Rect>([["a", { top: 0, left: 0 }]]);
    withLayout(positions);
    captureAnimations();

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

  it("retargets from where the row is drawn, not from its full old offset", () => {
    const positions = new Map<string, Rect>([["a", { top: 0, left: 0 }]]);
    withLayout(positions);
    captureAnimations();
    const { rerender } = render(<List keys={["a"]} />);
    positions.set("a", { top: 40, left: 0 });
    rerender(<List keys={["a"]} />);

    // Mid-glide the row is still drawn 10px above its layout position.
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      transform: "matrix(1, 0, 0, 1, 0, -10)",
    } as CSSStyleDeclaration);
    positions.set("a", { top: 80, left: 0 });
    rerender(<List keys={["a"]} />);

    // Layout moved another 40px down; the eye last saw the row 10px up from the
    // old layout, so the new glide starts 50px up — not 40, which would snap the
    // row down by 10px before setting off.
    expect(animations[1].keyframes).toEqual([
      { transform: "translate(0px, -50px)" },
      { transform: "none" },
    ]);
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
