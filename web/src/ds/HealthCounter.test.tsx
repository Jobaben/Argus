import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HealthCounter } from "./HealthCounter";

describe("HealthCounter", () => {
  it("renders value and label", () => {
    render(<HealthCounter label="Agents" value={12} />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });
});
