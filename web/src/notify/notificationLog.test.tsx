import { describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  LOG_CAP,
  clearNotifications,
  logNotification,
  markAllRead,
  resetNotificationLogForTest,
  unreadCount,
  useNotificationLog,
} from "./notificationLog";
import { NotificationCenter } from "./NotificationCenter";

beforeEach(() => {
  resetNotificationLogForTest();
});

function Probe() {
  const log = useNotificationLog();
  return (
    <ul>
      {log.map((e) => (
        <li key={e.id}>{`${e.title}${e.read ? " (read)" : ""}`}</li>
      ))}
    </ul>
  );
}

describe("notificationLog", () => {
  it("keeps entries newest-first", () => {
    render(<Probe />);
    act(() => {
      logNotification({ tone: "fail", title: "first" });
      logNotification({ tone: "ok", title: "second" });
    });
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["second", "first"]);
  });

  it("caps the log so a long session cannot grow without bound", () => {
    render(<Probe />);
    act(() => {
      for (let i = 0; i < LOG_CAP + 10; i += 1) logNotification({ tone: "ok", title: `n${i}` });
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(LOG_CAP);
    // The oldest are the ones dropped.
    expect(screen.queryByText("n0")).toBeNull();
  });

  it("counts unread entries and clears them together", () => {
    render(<Probe />);
    act(() => {
      logNotification({ tone: "fail", title: "a" });
      logNotification({ tone: "fail", title: "b" });
    });
    expect(screen.queryAllByText(/\(read\)/)).toHaveLength(0);
    act(() => markAllRead());
    expect(screen.getAllByText(/\(read\)/)).toHaveLength(2);
  });

  it("empties on clear", () => {
    render(<Probe />);
    act(() => logNotification({ tone: "ok", title: "a" }));
    act(() => clearNotifications());
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("counts unread over a list", () => {
    expect(
      unreadCount([
        { id: "1", tone: "ok", title: "a", at: 0, read: false },
        { id: "2", tone: "ok", title: "b", at: 0, read: true },
      ]),
    ).toBe(1);
  });
});

describe("NotificationCenter", () => {
  it("shows no badge when there is nothing unread", () => {
    render(<NotificationCenter />);
    expect(screen.getByRole("button", { name: /none unread/i })).toBeInTheDocument();
  });

  it("badges the unread count and caps the display at 9+", () => {
    render(<NotificationCenter />);
    act(() => {
      logNotification({ tone: "fail", title: "one" });
    });
    expect(screen.getByRole("button", { name: /1 unread/i })).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();

    act(() => {
      for (let i = 0; i < 12; i += 1) logNotification({ tone: "fail", title: `n${i}` });
    });
    expect(screen.getByText("9+")).toBeInTheDocument();
  });

  it("explains itself when empty rather than showing a blank panel", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByText(/nothing yet/i)).toBeInTheDocument();
  });

  it("lists entries and links one that names a destination", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    act(() => {
      logNotification({
        tone: "fail",
        title: "Monitor down: Nightly",
        detail: "expected a run, none arrived",
        href: "#/monitors",
      });
    });
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByText("Monitor down: Nightly")).toBeInTheDocument();
    // Prose, so in the body face: mono is kept for machine text.
    expect(screen.getByText("expected a run, none arrived")).not.toHaveClass("font-mono");
    expect(screen.getByRole("link", { name: /Monitor down/ })).toHaveAttribute(
      "href",
      "#/monitors",
    );
  });

  it("sets a detail that is machine text in mono", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    act(() => {
      logNotification({
        tone: "ok",
        title: "Agent done: Builder",
        detail: "a1b2c3",
        detailMono: true,
      });
    });
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByText("a1b2c3")).toHaveClass("font-mono");
  });

  it("treats opening as the acknowledgement", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    act(() => logNotification({ tone: "fail", title: "one" }));
    expect(screen.getByRole("button", { name: /1 unread/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByRole("button", { name: /none unread/i })).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hands focus back to the bell when Escape closes it from inside", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    act(() => logNotification({ tone: "fail", title: "one" }));
    const bell = screen.getByRole("button", { name: /notifications/i });
    await user.click(bell);
    await user.tab();
    expect(screen.getByRole("button", { name: "Clear" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bell).toHaveFocus();
  });

  it("closes when Tab leaves it, leaving focus on the page where it went", async () => {
    const user = userEvent.setup();
    render(
      <>
        <NotificationCenter />
        <button type="button">On the page</button>
      </>,
    );
    const bell = screen.getByRole("button", { name: /notifications/i });
    await user.click(bell);
    // From the bell into the panel is still inside: it stays open.
    await user.tab();
    expect(screen.getByRole("link", { name: "Briefing" })).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();

    // Past the panel's one link and on to the page: the panel goes, and does
    // not pull focus back to the bell.
    await user.tab();
    const page = screen.getByRole("button", { name: "On the page" });
    expect(page).toHaveFocus();
    expect(bell).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves focus where it is when Escape closes it from out on the page", async () => {
    const user = userEvent.setup();
    render(
      <>
        <NotificationCenter />
        <button type="button">On the page</button>
      </>,
    );
    const page = screen.getByRole("button", { name: "On the page" });
    page.focus();
    // Opened by a click that leaves focus where it was, as Safari's does: a
    // button there takes no focus from a click.
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(page).toHaveFocus();
  });

  it("stays open under an Escape that something in front has claimed", async () => {
    const user = userEvent.setup();
    render(
      <>
        <NotificationCenter />
        <input
          aria-label="Claims Escape"
          onKeyDown={(e) => {
            if (e.key === "Escape") e.preventDefault();
          }}
        />
      </>,
    );
    const field = screen.getByRole("textbox", { name: "Claims Escape" });
    field.focus();
    // Opened without moving focus (see above), so the Escape starts there.
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
  });

  it("keeps focus on the bell once Clear has emptied it", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    act(() => logNotification({ tone: "fail", title: "one" }));
    const bell = screen.getByRole("button", { name: /notifications/i });
    await user.click(bell);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByText(/nothing yet/i)).toBeInTheDocument();
    expect(bell).toHaveFocus();
  });

  it("points at the Briefing for what happened before this session", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByText(/this session only/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Briefing" })).toHaveAttribute("href", "#/briefing");
  });
});
