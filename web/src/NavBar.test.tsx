import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NavBar } from "./NavBar";

const destinations = [
  { id: "command", label: "Command Center" },
  { id: "schedules", label: "Scheduler" },
];
const overflow = [{ id: "stats", label: "Stats", href: "#/stats" }];

describe("NavBar", () => {
  it("renders the two destinations and drops the old monitoring strip", () => {
    render(<NavBar destinations={destinations} overflow={overflow} activeId="command" live />);
    expect(screen.getByRole("link", { name: "Command Center" })).toHaveAttribute(
      "href",
      "#/command",
    );
    expect(screen.getByRole("link", { name: "Scheduler" })).toHaveAttribute("href", "#/schedules");
    expect(screen.queryByRole("link", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Inventory" })).toBeNull();
  });

  it("exposes search and the connection state", () => {
    render(<NavBar destinations={destinations} overflow={overflow} activeId="command" live />);
    expect(screen.getByRole("link", { name: "Search" })).toHaveAttribute("href", "#/search");
    expect(screen.getByText("Live")).toBeInTheDocument();
  });
});

describe("NavBar badge", () => {
  it("renders a count chip on tabs with a badge and omits it at zero", () => {
    render(
      <NavBar
        destinations={[
          { id: "briefing", label: "Briefing", badge: 3 },
          { id: "command", label: "Command Center", badge: 0 },
        ]}
        overflow={overflow}
        activeId="command"
        live
      />,
    );
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
  });
});
