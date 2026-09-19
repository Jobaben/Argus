import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TriggerFields } from "./TriggerFields";

const FIELD = "field";

describe("TriggerFields", () => {
  it("shows the Manual option only when allowManual is set", () => {
    const { rerender } = render(
      <TriggerFields
        fieldClass={FIELD}
        value={{ kind: "daily", time: "02:00" }}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("option", { name: /manual/i })).toBeNull();
    rerender(<TriggerFields fieldClass={FIELD} allowManual value={null} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: /manual/i })).toBeTruthy();
  });

  it("emits null when Manual is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TriggerFields
        fieldClass={FIELD}
        allowManual
        value={{ kind: "daily", time: "02:00" }}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getAllByRole("combobox")[0], "manual");
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("emits an interval trigger when interval is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TriggerFields
        fieldClass={FIELD}
        value={{ kind: "daily", time: "02:00" }}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getAllByRole("combobox")[0], "interval");
    expect(onChange).toHaveBeenCalledWith({ kind: "interval", everyMinutes: 60 });
  });

  it("shows the windowed option only when allowWindowed is set", () => {
    const { rerender } = render(
      <TriggerFields
        fieldClass={FIELD}
        value={{ kind: "daily", time: "02:00" }}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("option", { name: /during a daily window/i })).toBeNull();
    rerender(
      <TriggerFields
        fieldClass={FIELD}
        allowWindowed
        value={{ kind: "daily", time: "02:00" }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("option", { name: /during a daily window/i })).toBeTruthy();
  });

  it("emits a windowed trigger with defaults when selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TriggerFields
        fieldClass={FIELD}
        allowWindowed
        value={{ kind: "daily", time: "02:00" }}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getAllByRole("combobox")[0], "windowed");
    expect(onChange).toHaveBeenCalledWith({
      kind: "windowed",
      startTime: "09:00",
      endTime: "17:00",
      everyMinutes: 30,
    });
  });

  it("emits a bare webhook trigger when selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TriggerFields
        fieldClass={FIELD}
        value={{ kind: "daily", time: "02:00" }}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getAllByRole("combobox")[0], "webhook");
    expect(onChange).toHaveBeenCalledWith({ kind: "webhook" });
  });

  it("shows a save-first hint for an unsaved webhook trigger, and the URL/token once saved", () => {
    const { rerender } = render(
      <TriggerFields fieldClass={FIELD} value={{ kind: "webhook" }} onChange={() => {}} />,
    );
    expect(screen.getByText(/save the pipeline\/schedule/i)).toBeTruthy();

    rerender(
      <TriggerFields
        fieldClass={FIELD}
        value={{ kind: "webhook" }}
        onChange={() => {}}
        hook={{ url: "https://argus.example/api/hooks/pipelines/p1", token: "tok123", onRotate: vi.fn() }}
      />,
    );
    expect(screen.getByText("https://argus.example/api/hooks/pipelines/p1")).toBeTruthy();
    expect(screen.getByText("tok123")).toBeTruthy();
  });

  it("rotate asks for confirmation, then calls onRotate", async () => {
    const user = userEvent.setup();
    const onRotate = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <TriggerFields
        fieldClass={FIELD}
        value={{ kind: "webhook" }}
        onChange={() => {}}
        hook={{ url: "https://argus.example/hook", token: "tok123", onRotate }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /rotate token/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onRotate).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("emits an after trigger naming the first offered pipeline", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TriggerFields
        fieldClass={FIELD}
        value={{ kind: "daily", time: "02:00" }}
        onChange={onChange}
        pipelines={[
          { id: "p1", name: "Pipeline One" },
          { id: "p2", name: "Pipeline Two" },
        ]}
      />,
    );
    await user.selectOptions(screen.getAllByRole("combobox")[0], "after");
    expect(onChange).toHaveBeenCalledWith({ kind: "after", pipelineId: "p1", on: "any" });
  });

  it("edits the source pipeline and outcome of an after trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TriggerFields
        fieldClass={FIELD}
        value={{ kind: "after", pipelineId: "p1", on: "any" }}
        onChange={onChange}
        pipelines={[
          { id: "p1", name: "Pipeline One" },
          { id: "p2", name: "Pipeline Two" },
        ]}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Source pipeline"), "p2");
    expect(onChange).toHaveBeenCalledWith({ kind: "after", pipelineId: "p2", on: "any" });
    await user.selectOptions(screen.getByLabelText("On outcome"), "failed");
    expect(onChange).toHaveBeenCalledWith({ kind: "after", pipelineId: "p1", on: "failed" });
  });

  it("toggles a weekday on the windowed trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TriggerFields
        fieldClass={FIELD}
        allowWindowed
        value={{ kind: "windowed", startTime: "12:00", endTime: "14:00", everyMinutes: 30 }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Mon" }));
    expect(onChange).toHaveBeenCalledWith({
      kind: "windowed",
      startTime: "12:00",
      endTime: "14:00",
      everyMinutes: 30,
      weekdays: [1],
    });
  });
});
