import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ToastRegion, type ToastItem } from "./Toast";

const toast: ToastItem = {
  id: "t1",
  tone: "fail",
  title: "Agent failed: Builder",
  detail: "abc123",
};

describe("ToastRegion", () => {
  it("renders nothing when empty", () => {
    render(<ToastRegion toasts={[]} onDismiss={() => {}} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders a toast's title, detail and badge", () => {
    render(<ToastRegion toasts={[toast]} onDismiss={() => {}} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Agent failed: Builder")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("invokes onDismiss with the toast id", () => {
    const onDismiss = vi.fn();
    render(<ToastRegion toasts={[toast]} onDismiss={onDismiss} />);
    screen.getByRole("button", { name: /dismiss/i }).click();
    expect(onDismiss).toHaveBeenCalledWith("t1");
  });
});

describe("the toast lifecycle", () => {
  it("animates a toast in rather than popping it into existence", () => {
    const { container } = render(<ToastRegion toasts={[toast]} onDismiss={() => {}} />);
    expect(container.innerHTML).toContain("toast-in");
  });

  it("keeps a dismissed toast on screen long enough to leave", () => {
    // The queues that own these simply delete the item, so without this the
    // toast is already gone by the time anything could animate it.
    const { container, rerender } = render(<ToastRegion toasts={[toast]} onDismiss={() => {}} />);
    rerender(<ToastRegion toasts={[]} onDismiss={() => {}} />);
    expect(screen.getByText("Agent failed: Builder")).toBeInTheDocument();
    expect(container.innerHTML).toContain("toast-out");
  });

  it("leaves sideways, so a dismissal never reads as the toast below moving up", () => {
    const css = readFileSync(path.join(__dirname, "..", "index.css"), "utf8");
    const frames = /@keyframes toast-out \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(frames).toContain("translateX");
  });

  it("is inert and unreachable while leaving, so a dismissal cannot be clicked twice", () => {
    // A leaving toast is a picture of a toast. Left live it stays clickable and
    // stays in the accessibility tree — a second `onDismiss` for something already
    // dismissed, and a screen reader walking into a notification that is gone.
    const onDismiss = vi.fn();
    const { rerender } = render(<ToastRegion toasts={[toast]} onDismiss={onDismiss} />);
    rerender(<ToastRegion toasts={[]} onDismiss={onDismiss} />);

    const leaving = screen.getByText("Agent failed: Builder").closest("[role=status]");
    expect(leaving).toHaveAttribute("inert");
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    expect(leaving).toHaveClass("pointer-events-none");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("is reachable while it is actually there", () => {
    render(<ToastRegion toasts={[toast]} onDismiss={() => {}} />);
    const live = screen.getByRole("status");
    expect(live).not.toHaveAttribute("inert");
    expect(live).toHaveClass("pointer-events-auto");
  });
});
