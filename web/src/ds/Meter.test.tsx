import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Meter } from "./Meter";

describe("Meter", () => {
  it("renders nothing when no metric is known", () => {
    const { container } = render(<Meter level="step" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders zero values when reported", () => {
    render(<Meter level="step" tokens={0} usd={0} title="zero" />);
    expect(screen.getByTitle("zero")).toHaveTextContent("0 tok · $0.0000");
  });

  it("joins duration, tokens and cost at step level", () => {
    render(<Meter level="step" durationMs={128000} tokens={96000} usd={1.44} title="step" />);
    expect(screen.getByTitle("step")).toHaveTextContent("2m 8s · 96.0k tok · $1.44");
  });

  it("draws the divider only when asked", () => {
    const { container, rerender } = render(<Meter level="step" tokens={1} />);
    expect((container.firstElementChild as HTMLElement).className).not.toContain("border-l");
    rerender(<Meter level="step" tokens={1} divider />);
    expect((container.firstElementChild as HTMLElement).className).toContain("border-l");
  });

  it("shows the run-total label at row level", () => {
    render(<Meter level="row" tokens={393000} usd={5.9} title="row" />);
    const meter = screen.getByTitle("row");
    expect(meter).toHaveTextContent("run total");
    expect(meter).toHaveTextContent("393.0k tok · $5.90");
  });

  it("renders the board glance with label and units", () => {
    render(<Meter level="board" tokens={1_200_000} usd={18.4} title="board" />);
    expect(screen.getByText("Total spend")).toBeInTheDocument();
    expect(screen.getByTitle("board")).toHaveTextContent("1.2M tok · $18.40");
  });

  it("hides an unknown metric instead of rendering a placeholder", () => {
    render(<Meter level="row" usd={0.5} title="row" />);
    const meter = screen.getByTitle("row");
    expect(meter).toHaveTextContent("$0.50");
    expect(meter).not.toHaveTextContent("tok");
  });
});
