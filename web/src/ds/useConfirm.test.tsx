import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useConfirm } from "./useConfirm";
import { useAsk } from "./useAsk";

function Card({ onDelete }: { onDelete: () => void }) {
  const confirm = useConfirm();
  return (
    <footer>
      <button
        type="button"
        aria-expanded={confirm.armed === "delete"}
        onClick={confirm.toggle("delete")}
      >
        Delete
      </button>
      {confirm.armed === "delete" &&
        confirm.question(
          {
            title: "Delete schedule “Nightly”?",
            detail: "Its 2 running instances will be stopped first.",
            confirm: "Delete schedule",
            cancel: "Keep",
          },
          onDelete,
        )}
    </footer>
  );
}

describe("useConfirm", () => {
  it("asks in place, with the safe answer focused, before anything happens", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<Card onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const group = screen.getByRole("group", { name: "Delete schedule “Nightly”?" });
    expect(group).toHaveAccessibleDescription("Its 2 running instances will be stopped first.");
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute("aria-expanded", "true");
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("does nothing on Keep and hands focus back to the button that asked", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<Card onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("treats Escape as Keep", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<Card onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("runs the action once on the verb", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<Card onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete schedule" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("closes again when the button that opened it is pressed a second time", async () => {
    const user = userEvent.setup();
    render(<Card onDelete={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("group")).toBeNull();
  });
});

function Saver({ onAnswer }: { onAnswer: (yes: boolean) => void }) {
  const [ask, question] = useAsk();
  const [saving, setSaving] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-disabled={saving || undefined}
        onClick={async () => {
          setSaving(true);
          onAnswer(
            await ask({
              title: "1 instance is running.",
              confirm: "Save anyway",
              tone: "secondary",
            }),
          );
          setSaving(false);
        }}
      >
        Save
      </button>
      {question}
    </div>
  );
}

describe("useAsk", () => {
  it("resolves false on Cancel and puts focus back where the action started", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Saver onAnswer={onAnswer} />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
  });

  it("resolves true on the verb", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Saver onAnswer={onAnswer} />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true));
  });
});
