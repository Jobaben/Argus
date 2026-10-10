import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InfoTip } from "./InfoTip";
import { Legend } from "./Legend";

describe("InfoTip", () => {
  it("opens on click with its explanation and note, and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <InfoTip title="Unverified" note="Not the same as unverifiable." footer="§15">
        Nobody looked.
      </InfoTip>,
    );
    const button = screen.getByRole("button", { name: "What is unverified?" });
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    const panel = screen.getByRole("dialog", { name: "Unverified" });
    expect(panel).toHaveTextContent("Nobody looked.");
    expect(panel).toHaveTextContent("Not the same as unverifiable.");
    expect(panel).toHaveTextContent("§15");
    expect(button).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("claims Escape so an enclosing surface stays open", async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(<InfoTip title="Stale">Moved on.</InfoTip>);
    await user.click(screen.getByRole("button"));
    await user.keyboard("{Escape}");
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
  });

  it("closes on an outside click and toggles from its trigger", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <span>outside</span>
        <InfoTip title="Supported" trigger="all supported" align="end">
          Signals in force.
        </InfoTip>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "all supported" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Legend", () => {
  it("pairs each mark with its label, description and note", () => {
    render(
      <Legend
        label="Kinds"
        items={[
          {
            key: "a",
            mark: "◆",
            label: "Business rule",
            description: "A rule.",
            note: "First class.",
          },
          { key: "b", mark: "●", label: "Fact", description: "Observed." },
        ]}
      />,
    );
    const legend = screen.getByLabelText("Kinds");
    expect(legend).toHaveTextContent("Business rule");
    expect(legend).toHaveTextContent("First class.");
    expect(legend).toHaveTextContent("Observed.");
  });
});
