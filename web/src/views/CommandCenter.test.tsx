import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import CommandCenter from "./CommandCenter";

describe("CommandCenter", () => {
  it("renders all seven phase columns", () => {
    render(<CommandCenter />);
    for (const name of [
      "Brainstorm", "Design", "Write spec", "Impl plan", "Implement", "Review", "Approve · iterate",
    ]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });
  it("renders an approval gate for await tiles", () => {
    render(<CommandCenter />);
    expect(screen.getAllByRole("button", { name: /approve/i }).length).toBeGreaterThan(0);
  });
});
