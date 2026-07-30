import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Drawer } from "./Drawer";

function open(props: Partial<Parameters<typeof Drawer>[0]> = {}) {
  const onClose = vi.fn();
  const result = render(
    <Drawer open title="Failing step" onClose={onClose} {...props}>
      <p>body</p>
    </Drawer>,
  );
  return { ...result, onClose };
}

/** jsdom reports every box as 0×0; the drag maths needs a width to reason about. */
function withWidth(px: number) {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: px,
    height: 800,
    top: 0,
    left: 0,
    right: px,
    bottom: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

afterEach(() => vi.restoreAllMocks());

describe("Drawer", () => {
  it("renders nothing when closed", () => {
    render(
      <Drawer open={false} title="Step" onClose={() => {}}>
        <p>body</p>
      </Drawer>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays in the document while it leaves, then goes", async () => {
    const { rerender, onClose } = open();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(
      <Drawer open={false} title="Failing step" onClose={onClose}>
        <p>body</p>
      </Drawer>,
    );
    // A drawer that slides in over 180ms and vanishes in zero is the tell this
    // whole change exists to remove.
    expect(screen.getByRole("dialog", { hidden: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
  });

  it("is inert and hidden while leaving, so nothing lands on a surface that is going", () => {
    const { rerender, onClose } = open();
    rerender(
      <Drawer open={false} title="Failing step" onClose={onClose}>
        <p>body</p>
      </Drawer>,
    );
    const scrim = screen.getByRole("dialog", { hidden: true }).parentElement!;
    expect(scrim).toHaveAttribute("inert");
    // Both, because jsdom implements `inert` as an attribute and nothing more:
    // without `aria-hidden` a leaving surface stays visible to role queries.
    expect(scrim).toHaveAttribute("aria-hidden", "true");
  });

  it("still closes on Escape, from the focus it moves into itself", async () => {
    const user = userEvent.setup();
    const { onClose } = open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Esc" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("grows from the row that opened it when told where that was", () => {
    open({ originY: 420 });
    expect(screen.getByRole("dialog").style.transformOrigin).toBe("right 420px");
  });

  it("invents no origin when it was not given one — a keyboard selection has no row", () => {
    open();
    expect(screen.getByRole("dialog").style.transformOrigin).toBe("");
  });

  it("dismisses on a flick, at the speed it was flicked", () => {
    withWidth(520);
    const { onClose } = open();
    const header = screen.getByRole("heading", { name: "Failing step" }).closest("header")!;

    fireEvent.pointerDown(header, { button: 0, clientX: 0, timeStamp: 0 });
    // Fast and short: a flick is stated as velocity, and waiting for a distance
    // threshold is what makes a fast gesture feel ignored.
    fireEvent.pointerMove(window, { clientX: 40, timeStamp: 20 });
    fireEvent.pointerUp(window, { clientX: 40, timeStamp: 20 });

    expect(onClose).not.toHaveBeenCalled(); // it leaves first, then reports
    return waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("springs back from a slow drag that never committed", async () => {
    withWidth(520);
    const { onClose } = open();
    const header = screen.getByRole("heading", { name: "Failing step" }).closest("header")!;

    fireEvent.pointerDown(header, { button: 0, clientX: 0, timeStamp: 0 });
    fireEvent.pointerMove(window, { clientX: 30, timeStamp: 400 });
    fireEvent.pointerUp(window, { clientX: 30, timeStamp: 800 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("tracks the pointer 1:1 while dragging", () => {
    withWidth(520);
    open();
    const header = screen.getByRole("heading", { name: "Failing step" }).closest("header")!;
    const panel = screen.getByRole("dialog");

    fireEvent.pointerDown(header, { button: 0, clientX: 100, timeStamp: 0 });
    fireEvent.pointerMove(window, { clientX: 180, timeStamp: 16 });
    // Anything less than exact is what makes a drag feel like a suggestion.
    expect(panel.style.transform).toBe("translateX(80px)");
  });

  it("refuses to drag leftwards — the drawer lives on the right edge", () => {
    withWidth(520);
    open();
    const header = screen.getByRole("heading", { name: "Failing step" }).closest("header")!;
    const panel = screen.getByRole("dialog");

    fireEvent.pointerDown(header, { button: 0, clientX: 100, timeStamp: 0 });
    fireEvent.pointerMove(window, { clientX: 20, timeStamp: 16 });
    expect(panel.style.transform).not.toContain("-");
  });

  it("lets a click on the close button be a click, not a drag", async () => {
    withWidth(520);
    const { onClose } = open();
    await userEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("a gesture that outlives the drawer", () => {
  it("does not report a close after the drawer has gone", async () => {
    // A flick hands `onClose` to a timer so the panel can finish leaving first. If
    // the drawer is torn down in between — the route changed, the row it belonged
    // to vanished — that timer would still fire and close something that closed
    // long ago, which for a caller that reuses the handler is a spurious dismissal.
    withWidth(520);
    const { onClose, unmount } = open();
    const header = screen.getByRole("heading", { name: "Failing step" }).closest("header")!;

    fireEvent.pointerDown(header, { button: 0, clientX: 0, timeStamp: 0 });
    fireEvent.pointerMove(window, { clientX: 40, timeStamp: 20 });
    fireEvent.pointerUp(window, { clientX: 40, timeStamp: 20 });

    unmount();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops tracking the pointer once it is gone", () => {
    // The move listener lives on `window`, so without teardown it keeps firing
    // after unmount — writing transforms to a detached panel for as long as the
    // user holds the button down.
    withWidth(520);
    const { unmount } = open();
    const header = screen.getByRole("heading", { name: "Failing step" }).closest("header")!;
    const panel = screen.getByRole("dialog");

    fireEvent.pointerDown(header, { button: 0, clientX: 100, timeStamp: 0 });
    fireEvent.pointerMove(window, { clientX: 180, timeStamp: 16 });
    expect(panel.style.transform).toBe("translateX(80px)");

    unmount();
    fireEvent.pointerMove(window, { clientX: 300, timeStamp: 32 });
    expect(panel.style.transform).toBe("translateX(80px)"); // unchanged
  });
});
