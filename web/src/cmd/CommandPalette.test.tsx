import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette";
import type { Command } from "./commands";

const COMMANDS: Command[] = [
  { id: "go:command", title: "Command Center", group: "Go to", href: "#/command", badge: "g c" },
  { id: "go:monitors", title: "Monitors", group: "Go to", href: "#/monitors" },
  {
    id: "approve:i1",
    title: "Approve — Release train",
    subtitle: "resume the pipeline waiting at its gate",
    group: "Actions",
    severity: "warn",
    run: () => Promise.resolve(),
  },
  {
    id: "entry:schedule:s1",
    title: "Dependency audit",
    subtitle: "every 6h",
    group: "Schedules",
    href: "#/schedules",
  },
  {
    id: "run:s2",
    title: "Run now — Monitor sweep",
    group: "Actions",
    run: () => Promise.resolve(),
  },
];

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "#/command";
});

/** Renders the palette and waits for the input to take focus, which happens on
 *  the next frame — typing before that would go to the document. */
async function open(commands: Command[] = COMMANDS, onClose = vi.fn()) {
  const user = userEvent.setup();
  const view = render(<CommandPalette open onClose={onClose} commands={commands} />);
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
  return { user, onClose, unmount: view.unmount };
}

describe("CommandPalette — structure", () => {
  it("renders as a modal combobox over a labelled listbox", async () => {
    await open();
    const dialog = screen.getByRole("dialog", { name: /command palette/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const input = screen.getByRole("combobox");
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
  });

  it("points aria-activedescendant at the highlighted option, without moving focus", async () => {
    const { user } = await open();
    const input = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[1].id);
    expect(input).toHaveFocus(); // focus never leaves the field
  });

  it("groups results and shows a match count", async () => {
    await open();
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("Go to")).toBeInTheDocument();
    expect(screen.getByText("5 of 5")).toBeInTheDocument();
  });

  it("puts the group of the top-ranked match first", async () => {
    const { user } = await open();
    // Both "Monitors" (Go to) and "Run now — Monitor sweep" (Actions) match,
    // but the exact leading hit ranks higher — so its group leads, even though
    // Actions sorts first by default.
    await user.keyboard("monitor");
    const headings = screen
      .getAllByRole("group")
      .map((g) => g.firstElementChild?.textContent ?? "");
    expect(headings[0]).toBe("Go to");
  });
});

describe("CommandPalette — filtering", () => {
  it("filters as you type, fuzzily", async () => {
    const { user } = await open();
    await user.keyboard("dpa");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByRole("option")).toHaveTextContent("Dependency audit");
  });

  it("highlights the matched characters in the title", async () => {
    const { user } = await open();
    await user.keyboard("mon");
    // The matched run is styled, so it is its own element.
    const top = screen.getAllByRole("option")[0];
    expect(top).toHaveTextContent("Monitors");
    expect(top.querySelector(".text-eye")?.textContent).toBe("Mon");
  });

  it("says so when nothing matches, without clearing the input", async () => {
    const { user } = await open();
    await user.keyboard("zzzz");
    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("zzzz");
    expect(screen.getByRole("combobox")).not.toHaveAttribute("aria-activedescendant");
  });

  it("keeps the highlight in range when the query shrinks the list", async () => {
    const { user } = await open();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}"); // last row
    await user.keyboard("dpa"); // now a single row
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });
});

describe("CommandPalette — running commands", () => {
  it("navigates on Enter and closes", async () => {
    const { user, onClose } = await open();
    await user.keyboard("monitors{Enter}");
    // The chosen row is marked and held for one beat before the navigation, so
    // you watch what you picked become what you got rather than the palette
    // cutting to a different page.
    await waitFor(() => expect(window.location.hash).toBe("#/monitors"));
    expect(onClose).toHaveBeenCalled();
  });

  it("navigates on click", async () => {
    const { user, onClose } = await open();
    await user.click(screen.getByRole("option", { name: /Monitors/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/monitors"));
    expect(onClose).toHaveBeenCalled();
  });

  it("wraps around the ends of the list", async () => {
    const { user } = await open();
    await user.keyboard("{ArrowUp}"); // from the first row, wrap to the last
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });

  it("jumps to the ends with Home and End", async () => {
    const { user } = await open();
    await user.keyboard("{End}");
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });

  it("closes on Escape", async () => {
    const { user, onClose } = await open();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("awaits an async action and reports its failure instead of closing", async () => {
    const failing: Command[] = [
      {
        id: "approve:i1",
        title: "Approve — Release train",
        group: "Actions",
        run: () => Promise.reject(new Error("instance is no longer awaiting approval")),
      },
    ];
    const { user, onClose } = await open(failing);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("no longer awaiting approval"),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes once an async action resolves", async () => {
    // TS narrows a `let` assigned only inside a callback to `null`, so hold the
    // resolver in a box it cannot narrow away.
    const gate: { resolve: (() => void) | null } = { resolve: null };
    const slow: Command[] = [
      {
        id: "approve:i1",
        title: "Approve — Release train",
        group: "Actions",
        run: () =>
          new Promise<void>((r) => {
            gate.resolve = r;
          }),
      },
    ];
    const { user, onClose } = await open(slow);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/working/i));
    expect(onClose).not.toHaveBeenCalled();
    gate.resolve?.();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("CommandPalette — recents", () => {
  it("floats a previously-run command to the top of an empty query", async () => {
    const first = await open();
    await first.user.keyboard("dpa{Enter}");
    first.unmount();

    // Reopen: the schedule that was just used now leads, ahead of the curated
    // "Go to" ordering.
    render(<CommandPalette open onClose={vi.fn()} commands={COMMANDS} />);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Dependency audit");
  });

  it("ignores recency once a query is typed", async () => {
    const first = await open();
    await first.user.keyboard("dpa{Enter}");
    first.unmount();

    const second = await open();
    await second.user.keyboard("monitors");
    // Relevance wins: the just-used schedule does not match, so it is gone —
    // recency never overrides what the user actually typed.
    const titles = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(titles[0]).toContain("Monitors");
    expect(titles.some((t) => t.includes("Dependency audit"))).toBe(false);
  });
});

describe("CommandPalette — mount lifecycle", () => {
  it("renders nothing while closed", () => {
    render(<CommandPalette open={false} onClose={vi.fn()} commands={COMMANDS} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts from an empty query each time it opens", async () => {
    const { user } = await open();
    await user.keyboard("monitors");
    const { unmount } = render(<CommandPalette open onClose={vi.fn()} commands={COMMANDS} />);
    unmount();
    render(<CommandPalette open onClose={vi.fn()} commands={COMMANDS} />);
    const inputs = screen.getAllByRole("combobox");
    expect(inputs[inputs.length - 1]).toHaveValue("");
  });

  it("returns focus to whatever had it before opening", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<CommandPalette open onClose={vi.fn()} commands={COMMANDS} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    unmount();
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });
});

describe("CommandPalette — intent mode", () => {
  const planResponse = {
    mode: "plan",
    answer: null,
    plan: {
      id: "plan-1",
      status: "ready",
      intent: "",
      mutations: [
        {
          kind: "schedule.disable",
          targetId: "s1",
          targetLabel: "Dependency audit",
          value: null,
          before: "enabled",
          after: "disabled",
        },
      ],
      warnings: [],
      summary: "Pause the dependency audit",
      createdAt: "2026-07-20T12:00:00.000Z",
      expiresAt: "2026-07-20T12:05:00.000Z",
    },
  };

  function stubPlan() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => planResponse,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("regression: a short query still fuzzy-jumps rather than asking a model", async () => {
    const fetchMock = stubPlan();
    const { user } = await open();
    await user.type(screen.getByRole("combobox"), "monitors");
    await user.keyboard("{Enter}");
    // The palette's whole reason to exist is the fast jump. Two words must
    // never become a paid planning pass.
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(window.location.hash).toBe("#/monitors"));
    vi.unstubAllGlobals();
  });

  it("a sentence advertises the interpret shortcut", async () => {
    stubPlan();
    const { user } = await open();
    await user.type(screen.getByRole("combobox"), "pause everything touching Spectacle");
    expect(screen.getByText(/interpret/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("a sentence that matches nothing teaches the interpret path in the empty state", async () => {
    stubPlan();
    const { user } = await open();
    await user.type(screen.getByRole("combobox"), "zzz qqq wwwwwwwwww");
    expect(screen.getByText(/reads like an instruction/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("pressing enter on a sentence compiles it into a preview", async () => {
    const fetchMock = stubPlan();
    const { user } = await open();
    await user.type(screen.getByRole("combobox"), "pause everything touching Spectacle");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("Dependency audit")).toBeInTheDocument());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/omnibar/plan");
    expect(screen.getByRole("button", { name: /Apply 1 change/ })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("⌘↵ interprets even when commands matched", async () => {
    const fetchMock = stubPlan();
    const { user } = await open();
    await user.type(screen.getByRole("combobox"), "run the dependency audit now");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it("regression: escape from intent mode goes back to the list, not away", async () => {
    stubPlan();
    const onClose = vi.fn();
    const { user } = await open(COMMANDS, onClose);
    await user.type(screen.getByRole("combobox"), "pause everything touching Spectacle");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("Dependency audit")).toBeInTheDocument());

    await user.keyboard("{Escape}");
    // Losing a typed sentence to a stray keypress is a real cost, so the first
    // Escape returns to the results.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("CommandPalette — the hand-off", () => {
  it("marks the chosen row while it leaves, so the jump has a visible source", async () => {
    const { user } = await open();
    await user.keyboard("monitors");
    await user.click(screen.getAllByRole("option")[0]);
    // The palette can teleport you anywhere, which is also why it is the easiest
    // place to lose your bearings. The row you picked is held, marked, for one
    // quick beat as the surface sinks.
    expect(screen.getAllByRole("option")[0].className).toContain("bg-eye");
    await waitFor(() => expect(window.location.hash).toBe("#/monitors"));
  });
});
