import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MoreMenu } from "./MoreMenu";

describe("MoreMenu", () => {
  it("hides items until opened, then shows them as links", async () => {
    const user = userEvent.setup();
    render(
      <MoreMenu active={false} items={[{ id: "stats", label: "Stats", href: "#/stats" }]} />,
    );
    expect(screen.queryByRole("menuitem", { name: "Stats" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /more/i }));

    expect(screen.getByRole("menuitem", { name: "Stats" })).toHaveAttribute("href", "#/stats");
  });

  it("closes when a menu item is clicked", async () => {
    const user = userEvent.setup();
    render(<MoreMenu active={false} items={[{ id: "stats", label: "Stats", href: "#/stats" }]} />);
    await user.click(screen.getByRole("button", { name: /more/i }));
    await user.click(screen.getByRole("menuitem", { name: "Stats" }));
    expect(screen.queryByRole("menuitem", { name: "Stats" })).toBeNull();
  });
});
