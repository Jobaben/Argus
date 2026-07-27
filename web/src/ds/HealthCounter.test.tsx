import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HealthCounter } from "./HealthCounter";

describe("HealthCounter", () => {
  it("renders value and label", () => {
    render(<HealthCounter label="Agents" value={12} />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("is not a control unless it is given something to do", () => {
    render(<HealthCounter label="Agents" value={12} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("becomes a pressable filter with an onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<HealthCounter label="Down" value={3} onClick={onClick} selected />);
    const button = screen.getByRole("button", { name: "3 Down" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
