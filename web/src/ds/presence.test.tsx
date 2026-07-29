import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { useState } from "react";
import { SURFACE, usePresence, useSurfaceMotion, useListPresence } from "./presence";
import { DURATION } from "./motion";

/**
 * These tests are about *when a surface is in the document*, which is the whole
 * point of the module: the exit is the window between "the user asked it to
 * close" and "it is gone", and before this hook that window was zero.
 */

function reduceMotion(reduce: boolean) {
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

function Overlay({ open }: { open: boolean }) {
  const { present, exited } = usePresence(open);
  const ref = useSurfaceMotion<HTMLDivElement>(open, SURFACE.rise, exited);
  if (!present) return null;
  return (
    <div ref={ref} data-testid="overlay" data-state={open ? "open" : "leaving"}>
      panel
    </div>
  );
}

afterEach(() => {
  reduceMotion(false);
  vi.useRealTimers();
});

describe("usePresence + useSurfaceMotion", () => {
  it("keeps the surface mounted while it leaves, then removes it", async () => {
    reduceMotion(false);
    const { rerender } = render(<Overlay open />);
    expect(screen.getByTestId("overlay")).toBeInTheDocument();

    rerender(<Overlay open={false} />);
    // Still there — this is the exit, and it is the thing that did not exist.
    expect(screen.getByTestId("overlay")).toHaveAttribute("data-state", "leaving");

    await waitFor(() => expect(screen.queryByTestId("overlay")).toBeNull());
  });

  it("paints the hidden state before the first frame, so the entrance has somewhere to come from", () => {
    reduceMotion(false);
    render(<Overlay open />);
    const overlay = screen.getByTestId("overlay");
    expect(overlay.style.opacity).toBe("0");
    expect(overlay.style.transform).toBe(SURFACE.rise.hidden.transform);
  });

  it("reverses an interrupted exit instead of restarting it", async () => {
    reduceMotion(false);
    // The animation that matters is the second one: re-opening mid-exit must seek
    // into the entrance rather than starting it at zero, or the surface visibly
    // snaps back to invisible before coming in again.
    const seeks: number[] = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function patched(
      this: Element,
      keyframes: Parameters<Element["animate"]>[0],
      options: Parameters<Element["animate"]>[1],
    ) {
      const animation = original.call(this, keyframes, options);
      const descriptor = { get: () => 0, set: (v: number) => seeks.push(v) };
      Object.defineProperty(animation, "currentTime", descriptor);
      return animation;
    } as typeof Element.prototype.animate;

    try {
      const { rerender } = render(<Overlay open />);
      rerender(<Overlay open={false} />);
      seeks.length = 0;
      rerender(<Overlay open />);
      // Reopened immediately, so the exit had made no progress: the entrance is
      // seeked to its *end*, not its start — the surface is already fully shown.
      expect(seeks.at(-1)).toBe(DURATION.base);
      expect(screen.getByTestId("overlay")).toBeInTheDocument();
    } finally {
      Element.prototype.animate = original;
    }
  });

  it("unmounts immediately under reduced motion, which is the behaviour those users already had", async () => {
    reduceMotion(true);
    const { rerender } = render(<Overlay open />);
    rerender(<Overlay open={false} />);
    await waitFor(() => expect(screen.queryByTestId("overlay")).toBeNull());
  });
});

function List({ items }: { items: string[] }) {
  const shown = useListPresence(
    items.map((id) => ({ id })),
    (i) => i.id,
    DURATION.exit,
  );
  return (
    <ul>
      {shown.map(({ key, leaving }) => (
        <li key={key} data-testid={key} data-leaving={leaving ? "yes" : "no"}>
          {key}
        </li>
      ))}
    </ul>
  );
}

describe("useListPresence", () => {
  it("holds a departed item in place long enough to animate out", async () => {
    reduceMotion(false);
    vi.useFakeTimers();
    const { rerender } = render(<List items={["a", "b", "c"]} />);
    rerender(<List items={["a", "c"]} />);

    // `b` is gone from the data and still on screen, marked as leaving — and
    // still in its old position, so the rows after it have not jumped yet.
    expect(screen.getByTestId("b")).toHaveAttribute("data-leaving", "yes");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["a", "b", "c"]);

    await act(async () => {
      vi.advanceTimersByTime(DURATION.exit + 1);
    });
    expect(screen.queryByTestId("b")).toBeNull();
  });

  it("keeps new arrivals in the incoming order", () => {
    reduceMotion(false);
    const { rerender } = render(<List items={["a"]} />);
    rerender(<List items={["a", "b"]} />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["a", "b"]);
    expect(screen.getByTestId("b")).toHaveAttribute("data-leaving", "no");
  });

  it("drops departed items at once under reduced motion", () => {
    reduceMotion(true);
    const { rerender } = render(<List items={["a", "b"]} />);
    rerender(<List items={["a"]} />);
    expect(screen.queryByTestId("b")).toBeNull();
  });
});

describe("a surface driven by state rather than props", () => {
  it("survives open → close → open without leaking a stale exit", async () => {
    reduceMotion(false);
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen((o) => !o)}>
            toggle
          </button>
          <Overlay open={open} />
        </>
      );
    }
    render(<Host />);
    const toggle = screen.getByRole("button", { name: "toggle" });

    act(() => toggle.click());
    act(() => toggle.click());
    // The re-open cancelled the exit; the surface must not disappear when the
    // cancelled animation's timer would have fired.
    await new Promise((resolve) => setTimeout(resolve, DURATION.exit + 20));
    expect(screen.getByTestId("overlay")).toBeInTheDocument();
  });
});
