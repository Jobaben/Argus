import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useGlobalKeys } from "./useGlobalKeys";
import type { Binding } from "./keys";

/** A page with the global layer installed and two fields: one that claims
 *  Escape for itself, as the palette does in intent mode, and one that does
 *  not. And a control that claims the arrows, as a menu does. */
function Page({ bindings }: { bindings: Binding[] }) {
  useGlobalKeys(bindings);
  return (
    <>
      <input
        aria-label="Claims Escape"
        onKeyDown={(e: ReactKeyboardEvent) => {
          if (e.key === "Escape") e.preventDefault();
        }}
      />
      <input aria-label="Plain field" />
      <button
        type="button"
        onKeyDown={(e: ReactKeyboardEvent) => {
          if (e.key === "ArrowDown") e.preventDefault();
        }}
      >
        Claims arrows
      </button>
    </>
  );
}

function escapeBinding(run: () => void): Binding {
  return { keys: "Escape", label: "Close", group: "General", allowInInput: true, run };
}

describe("useGlobalKeys", () => {
  it("leaves a key alone once something on the page has already handled it", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(<Page bindings={[escapeBinding(close)]} />);

    await user.click(screen.getByRole("textbox", { name: "Claims Escape" }));
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
  });

  it("still answers Escape everywhere nothing has claimed it", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(<Page bindings={[escapeBinding(close)]} />);

    await user.click(screen.getByRole("textbox", { name: "Plain field" }));
    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("still lets a claimed key disarm a half-typed chord", async () => {
    const user = userEvent.setup();
    const go = vi.fn();
    render(<Page bindings={[{ keys: "g c", label: "Command Center", group: "Go to", run: go }]} />);

    // `g`, then an arrow the menu takes for itself: the chord is over, so a
    // `c` straight after is just a `c`, as it would be after any other key.
    await user.click(screen.getByRole("button", { name: "Claims arrows" }));
    await user.keyboard("g{ArrowDown}c");
    expect(go).not.toHaveBeenCalled();

    await user.keyboard("gc");
    expect(go).toHaveBeenCalledTimes(1);
  });
});
