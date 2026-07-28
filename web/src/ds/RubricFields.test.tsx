import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RubricFields } from "./RubricFields";
import { slugify } from "./slug";
import type { Rubric } from "../types";

const FIELD = "field";

const RUBRIC: Rubric = {
  goal: "Be thorough.",
  criteria: [{ id: "coverage", label: "Covers everything" }],
  minScore: 6,
};

describe("slugify", () => {
  it("produces something the server will accept", () => {
    expect(slugify("Names Every Failure!")).toBe("names-every-failure-");
    expect(slugify("  leading")).toBe("leading");
    expect(slugify("x".repeat(80))).toHaveLength(40);
  });
});

describe("RubricFields", () => {
  it("is off by default and explains what turning it on buys you", () => {
    render(<RubricFields value={null} onChange={vi.fn()} fieldClass={FIELD} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByText(/Exit code 0 means the process ended/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("id")).not.toBeInTheDocument();
  });

  it("turning it on hands back a starter rubric", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RubricFields value={null} onChange={onChange} fieldClass={FIELD} />);
    await user.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "", criteria: [{ id: "", label: "" }] }),
    );
  });

  it("turning it off clears the rubric rather than leaving a husk", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RubricFields value={RUBRIC} onChange={onChange} fieldClass={FIELD} />);
    await user.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("regression: an id the server would reject cannot be typed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RubricFields value={RUBRIC} onChange={onChange} fieldClass={FIELD} />);
    await user.type(screen.getByLabelText("Criterion 1 id"), "!");
    const last = onChange.mock.calls.at(-1)?.[0] as Rubric;
    expect(last.criteria[0].id).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });

  it("explains that the id, not the label, keys the history", () => {
    render(<RubricFields value={RUBRIC} onChange={vi.fn()} fieldClass={FIELD} />);
    expect(screen.getByText(/change an id and the trend starts over/i)).toBeInTheDocument();
  });

  it("criteria can be added and removed, but never down to zero", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RubricFields value={RUBRIC} onChange={onChange} fieldClass={FIELD} />);
    // A single criterion has no remove control — an empty rubric is not valid.
    expect(screen.queryByRole("button", { name: /remove criterion/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /\+ criterion/i }));
    expect((onChange.mock.calls.at(-1)?.[0] as Rubric).criteria).toHaveLength(2);
  });

  it("auto-approve only appears where a gate can use it", () => {
    const { rerender } = render(
      <RubricFields value={RUBRIC} onChange={vi.fn()} fieldClass={FIELD} />,
    );
    expect(screen.queryByLabelText(/auto-approve/i)).not.toBeInTheDocument();

    rerender(
      <RubricFields
        value={RUBRIC}
        onChange={vi.fn()}
        fieldClass={FIELD}
        autoApprove={8}
        onAutoApproveChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("spinbutton", { name: /auto-approve this gate/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Every step of the phase must score at least this/i),
    ).toBeInTheDocument();
  });

  it("the threshold says plainly what leaving it empty means", () => {
    render(<RubricFields value={RUBRIC} onChange={vi.fn()} fieldClass={FIELD} />);
    expect(screen.getByText(/measure without ever failing anything/i)).toBeInTheDocument();
  });
});

describe("RubricFields — editing the details", () => {
  it("editing the goal, a weight and the threshold all flow out", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RubricFields value={RUBRIC} onChange={onChange} fieldClass={FIELD} />);

    await user.type(screen.getByPlaceholderText(/A triage summary/), "!");
    expect((onChange.mock.calls.at(-1)?.[0] as Rubric).goal).toBe("Be thorough.!");

    await user.clear(screen.getByLabelText("Criterion 1 weight"));
    await user.type(screen.getByLabelText("Criterion 1 weight"), "3");
    expect((onChange.mock.calls.at(-1)?.[0] as Rubric).criteria[0].weight).toBe(3);

    await user.type(screen.getByLabelText("Criterion 1 label"), "!");
    expect((onChange.mock.calls.at(-1)?.[0] as Rubric).criteria[0].label).toBe(
      "Covers everything!",
    );
  });

  it("clearing the weight or the threshold means 'unset', not zero", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const weighted: Rubric = { ...RUBRIC, criteria: [{ id: "coverage", label: "C", weight: 2 }] };
    render(<RubricFields value={weighted} onChange={onChange} fieldClass={FIELD} />);

    await user.clear(screen.getByLabelText("Criterion 1 weight"));
    expect((onChange.mock.calls.at(-1)?.[0] as Rubric).criteria[0].weight).toBeUndefined();

    const threshold = screen.getByRole("spinbutton", { name: /regression threshold/i });
    await user.clear(threshold);
    expect((onChange.mock.calls.at(-1)?.[0] as Rubric).minScore).toBeUndefined();
  });

  it("a second criterion can be removed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const two: Rubric = {
      ...RUBRIC,
      criteria: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    };
    render(<RubricFields value={two} onChange={onChange} fieldClass={FIELD} />);
    await user.click(screen.getByRole("button", { name: /remove criterion 2/i }));
    expect((onChange.mock.calls.at(-1)?.[0] as Rubric).criteria).toEqual([{ id: "a", label: "A" }]);
  });

  it("clearing the auto-approve bar means 'never'", async () => {
    const user = userEvent.setup();
    const onAutoApproveChange = vi.fn();
    render(
      <RubricFields
        value={RUBRIC}
        onChange={vi.fn()}
        fieldClass={FIELD}
        autoApprove={8}
        onAutoApproveChange={onAutoApproveChange}
      />,
    );
    const bar = screen.getByRole("spinbutton", { name: /auto-approve this gate/i });
    await user.clear(bar);
    expect(onAutoApproveChange).toHaveBeenLastCalledWith(null);
  });
});
