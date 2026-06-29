import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "./StatusPill";

describe("StatusPill", () => {
  it("renders the status label", () => {
    render(<StatusPill status="working" />);
    expect(screen.getByText("Working")).toBeInTheDocument();
  });
  it('shows "Needs approval" for await', () => {
    render(<StatusPill status="await" />);
    expect(screen.getByText("Needs approval")).toBeInTheDocument();
  });
});
