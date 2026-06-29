import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Page } from "./Page";

describe("Page", () => {
  it("renders the title as a heading and the children", () => {
    render(<Page title="Stats"><p>body content</p></Page>);
    expect(screen.getByRole("heading", { name: "Stats" })).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("renders crumbs as links pointing at their href", () => {
    render(
      <Page crumbs={[{ label: "Command Center", href: "#/command" }]} title="Agents">
        x
      </Page>,
    );
    expect(screen.getByRole("link", { name: "Command Center" })).toHaveAttribute(
      "href",
      "#/command",
    );
  });

  it("renders children even with no header props", () => {
    render(<Page><span>just body</span></Page>);
    expect(screen.getByText("just body")).toBeInTheDocument();
  });
});
