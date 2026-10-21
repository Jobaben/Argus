import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShortcutHelp } from "./ShortcutHelp";
import type { Binding } from "./keys";

const BINDINGS: Binding[] = [
  { keys: "?", label: "Show keyboard shortcuts", group: "General", run: vi.fn() },
  { keys: "g c", label: "Command Center", group: "Go to", run: vi.fn() },
];

/** The sheet over a page with controls of its own behind the scrim. */
async function openOverPage() {
  const user = userEvent.setup();
  render(
    <>
      <a href="#main">Skip to content</a>
      <ShortcutHelp open onClose={vi.fn()} bindings={BINDINGS} />
      <button type="button">Behind the scrim</button>
    </>,
  );
  const close = screen.getByRole("button", { name: "Close" });
  await waitFor(() => expect(close).toHaveFocus());
  return { user, close };
}

describe("ShortcutHelp", () => {
  it("opens as a labelled modal dialog with focus on Close", async () => {
    await openOverPage();
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Command Center")).toBeInTheDocument();
  });

  it("keeps Tab and Shift+Tab inside the sheet, between Close and the list", async () => {
    const { user, close } = await openOverPage();
    // The list is a stop, so on a short window the arrow keys can scroll it.
    const list = screen.getByRole("region", { name: "All shortcuts" });
    await user.tab();
    expect(list).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(list).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    expect(screen.getByRole("link", { name: "Skip to content" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Behind the scrim" })).not.toHaveFocus();
  });
});
