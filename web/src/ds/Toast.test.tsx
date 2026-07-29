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
});
