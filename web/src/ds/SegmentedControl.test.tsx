import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SegmentedControl } from "./SegmentedControl";

const SEGMENTS = [
  { value: "1", label: "1h" },
  { value: "24", label: "24h" },
];

describe("SegmentedControl", () => {
  it("renders a radiogroup with the selected segment checked", () => {
    render(
      <SegmentedControl label="Time window" segments={SEGMENTS} value="24" onChange={() => {}} />,
    );
    expect(screen.getByRole("radiogroup", { name: "Time window" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "24h" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "1h" })).toHaveAttribute("aria-checked", "false");
  });

  it("reports the clicked segment's value", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl label="Time window" segments={SEGMENTS} value="24" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "1h" }));
    expect(onChange).toHaveBeenCalledWith("1");
  });
});
