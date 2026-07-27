import { describe, it, expect, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("expected a run, none arrived")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Monitor down/ })).toHaveAttribute(
      "href",
      "#/monitors",
    );
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

  it("points at the Briefing for what happened before this session", async () => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByText(/this session only/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Briefing" })).toHaveAttribute("href", "#/briefing");
  });
});
