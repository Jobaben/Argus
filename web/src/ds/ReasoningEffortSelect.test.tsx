import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReasoningEffortSelect } from "./ReasoningEffortSelect";

describe("ReasoningEffortSelect", () => {
  it("offers runtime-provided efforts and supports inheriting the CLI default", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ReasoningEffortSelect
        fieldClass="field"
        label="Effort (inherit CLI)"
        efforts={["low", "medium", "high", "xhigh"]}
        onChange={onChange}
      />,
    );
    const select = screen.getByLabelText("Effort (inherit CLI)");
    expect(select).toHaveValue("");
    await user.selectOptions(select, "high");
    expect(onChange).toHaveBeenLastCalledWith("high");
    await user.selectOptions(select, "");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("renders nothing for a runtime without reasoning overrides", () => {
    const { container } = render(
      <ReasoningEffortSelect fieldClass="field" label="Effort" efforts={[]} onChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
