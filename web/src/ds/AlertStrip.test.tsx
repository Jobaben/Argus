import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AlertStrip } from "./AlertStrip";

describe("AlertStrip", () => {
  it("renders subject, message and badge", () => {
    render(<AlertStrip subject="deploy-bot" message="exit 1 · ActiveMQ refused" when="4m ago" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("deploy-bot")).toBeInTheDocument();
    expect(screen.getByText(/ActiveMQ refused/)).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});
