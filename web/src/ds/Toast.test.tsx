import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
