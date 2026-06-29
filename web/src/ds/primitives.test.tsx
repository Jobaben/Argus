import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card } from "./Card";
import { Section } from "./Section";
import { EmptyState } from "./EmptyState";

describe("primitives", () => {
  it("Card renders children on a surface", () => {
    const { container } = render(<Card>hi</Card>);
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("bg-surface");
  });
  it("Section shows its title and children", () => {
    render(<Section title="Watch">body</Section>);
    expect(screen.getByText("Watch")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });
  it("EmptyState renders its message", () => {
    render(<EmptyState>nothing here</EmptyState>);
    expect(screen.getByText("nothing here")).toBeInTheDocument();
  });
});
