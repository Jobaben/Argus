import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sparkline } from "./Sparkline";

describe("Sparkline", () => {
  it("renders label, value and a polyline", () => {
    const { container } = render(<Sparkline label="Runs" value="28" values={[1, 3, 2, 5]} />);
    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("28")).toBeInTheDocument();
    expect(container.querySelector("polyline")).toBeInTheDocument();
  });

  it("supports the run tone from the design system", () => {
    const { container } = render(
      <Sparkline label="Token cost" value="63.40" values={[1, 2]} tone="run" />,
    );
    expect(container.querySelector("polyline")).toHaveAttribute("stroke", "#ffb224");
  });
});
