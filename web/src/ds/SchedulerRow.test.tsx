import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SchedulerRow } from "./SchedulerRow";

describe("SchedulerRow", () => {
  it("renders name, formatted eta and trigger", () => {
    render(
      <SchedulerRow name="nightly-qa" etaMs={(7 * 60 + 41) * 60_000} trigger="daily · 02:00" />,
    );
    expect(screen.getByText("nightly-qa")).toBeInTheDocument();
    expect(screen.getByText("7h 41m")).toBeInTheDocument();
    expect(screen.getByText("daily · 02:00")).toBeInTheDocument();
  });
  it("renders a dash when eta is null", () => {
    render(<SchedulerRow name="x" etaMs={null} trigger="paused" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
