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
    render(
      <NavBar destinations={destinations} overflow={overflow} activeId="command" live />,
    );
    expect(screen.getByRole("link", { name: "Command Center" })).toHaveAttribute(
      "href",
      "#/command",
    );
    expect(screen.getByRole("link", { name: "Scheduler" })).toHaveAttribute(
      "href",
      "#/schedules",
    );
    expect(screen.queryByRole("link", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Inventory" })).toBeNull();
  });

  it("exposes search and the connection state", () => {
    render(
      <NavBar destinations={destinations} overflow={overflow} activeId="command" live />,
    );
    expect(screen.getByRole("link", { name: "Search" })).toHaveAttribute("href", "#/search");
    expect(screen.getByText("Live")).toBeInTheDocument();
  });
});
