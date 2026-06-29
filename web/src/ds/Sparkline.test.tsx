import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sparkline } from "./Sparkline";

describe("Sparkline", () => {
  it("renders label, value and a polyline", () => {
    const { container } = render(
      <Sparkline label="Runs" value="28" values={[1, 3, 2, 5]} />,
    );
    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("28")).toBeInTheDocument();
    expect(container.querySelector("polyline")).toBeInTheDocument();
  });
});
