import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionPill } from "./ConnectionPill";

describe("ConnectionPill", () => {
  it("shows Live when connected", () => {
    render(<ConnectionPill live />);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });
  it("shows Reconnecting when down", () => {
    render(<ConnectionPill live={false} />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });
});
