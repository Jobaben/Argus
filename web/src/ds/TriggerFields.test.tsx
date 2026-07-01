import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TriggerFields } from "./TriggerFields";

const FIELD = "field";

describe("TriggerFields", () => {
  it("shows the Manual option only when allowManual is set", () => {
    const { rerender } = render(
      <TriggerFields fieldClass={FIELD} value={{ kind: "daily", time: "02:00" }} onChange={() => {}} />,
    );
    expect(screen.queryByRole("option", { name: /manual/i })).toBeNull();
    rerender(
      <TriggerFields fieldClass={FIELD} allowManual value={null} onChange={() => {}} />,
    );
    expect(screen.getByRole("option", { name: /manual/i })).toBeTruthy();
  });

  it("emits null when Manual is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TriggerFields fieldClass={FIELD} allowManual value={{ kind: "daily", time: "02:00" }} onChange={onChange} />);
    await user.selectOptions(screen.getAllByRole("combobox")[0], "manual");
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("emits an interval trigger when interval is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TriggerFields fieldClass={FIELD} value={{ kind: "daily", time: "02:00" }} onChange={onChange} />);
    await user.selectOptions(screen.getAllByRole("combobox")[0], "interval");
    expect(onChange).toHaveBeenCalledWith({ kind: "interval", everyMinutes: 60 });
  });
});
