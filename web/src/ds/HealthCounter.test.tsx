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

  it("makes the filter that is on unmistakable, not a shade off its neighbours", () => {
    render(
      <>
        <HealthCounter label="Down" value={3} onClick={() => {}} selected />
        <HealthCounter label="Late" value={2} onClick={() => {}} />
      </>,
    );
    const on = screen.getByRole("button", { name: "3 Down" });
    const off = screen.getByRole("button", { name: "2 Late" });
    expect(on).toHaveAttribute("aria-pressed", "true");
    expect(off).toHaveAttribute("aria-pressed", "false");
    // A ring outside a full-ink border, a lifted surface, and a check: the
    // selected tile differs in shape as well as shade.
    expect(on.className).toMatch(/\bring-2\b/);
    expect(on.className).toContain("bg-surface-3");
    expect(on.querySelector("svg")).not.toBeNull();
    expect(off.className).not.toMatch(/\bring-2\b/);
    expect(off.querySelector("svg")).toBeNull();
    // Hover never restyles the selected tile, so the pointer resting on it
    // cannot make it look like the others.
    expect(on.className).not.toContain("hover:bg-surface-2");
    expect(off.className).toContain("hover:bg-surface-2");
  });

  it("keeps a zero neutral whatever its tone", () => {
    render(<HealthCounter label="Failed" value={0} tone="fail" />);
    expect(screen.getByText("0").className).toContain("text-ink-faint");
    expect(screen.getByText("0").className).not.toContain("text-fail");
  });
});
