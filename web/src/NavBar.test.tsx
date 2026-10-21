import { afterEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NavBar } from "./NavBar";

const destinations = [
  { id: "command", label: "Command Center" },
  { id: "schedules", label: "Scheduler" },
];
const overflow = [{ id: "stats", label: "Stats", href: "#/stats" }];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NavBar", () => {
  it("renders the two destinations and drops the old monitoring strip", () => {
    render(
      <NavBar
        destinations={destinations}
        overflow={overflow}
        activeId="command"
        live
        onOpenPalette={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "Command Center" })).toHaveAttribute(
      "href",
      "#/command",
    );
    expect(screen.getByRole("link", { name: "Scheduler" })).toHaveAttribute("href", "#/schedules");
    expect(screen.queryByRole("link", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Inventory" })).toBeNull();
  });

  it("exposes the command palette and the connection state", () => {
    const onOpenPalette = vi.fn();
    render(
      <NavBar
        destinations={destinations}
        overflow={overflow}
        activeId="command"
        live
        onOpenPalette={onOpenPalette}
      />,
    );
    // The palette replaced the old search link: it reaches search *and*
    // everything else, and it advertises its own shortcut.
    const button = screen.getByRole("button", { name: /command palette/i });
    fireEvent.click(button);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });
});

describe("NavBar badge", () => {
  it("renders a count chip on tabs with a badge and omits it at zero", () => {
    render(
      <NavBar
        destinations={[
          { id: "briefing", label: "Briefing", badge: 3 },
          { id: "command", label: "Command Center", badge: 0 },
        ]}
        overflow={overflow}
        activeId="command"
        live
        onOpenPalette={() => {}}
      />,
    );
    // Twice: once on the Briefing tab, once as the mobile menu's total. Both
    // render at every viewport (CSS hides one), so the count is not unique.
    expect(screen.getAllByText("3")).toHaveLength(2);
    expect(screen.queryByText("0")).toBeNull();
  });

  it("offers a menu on narrow viewports naming the current destination", async () => {
    const user = userEvent.setup();
    render(
      <NavBar
        destinations={[
          { id: "briefing", label: "Briefing", badge: 3 },
          { id: "command", label: "Command Center" },
        ]}
        overflow={overflow}
        activeId="command"
        live
        onOpenPalette={() => {}}
      />,
    );
    const toggle = screen.getByRole("button", { name: /open the menu/i });
    // The trigger names where you are, so the bar is still orienting when
    // collapsed.
    expect(toggle).toHaveTextContent("Command Center");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(screen.getByRole("button", { name: /close the menu/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // Every destination is reachable at once, plus the secondary list.
    expect(screen.getAllByRole("link", { name: /briefing/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Stats" }).length).toBeGreaterThan(0);
  });

  it("names a page from the secondary list too, rather than falling back to 'Menu'", () => {
    render(
      <NavBar
        destinations={destinations}
        overflow={overflow}
        activeId="stats"
        live
        onOpenPalette={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /open the menu/i })).toHaveTextContent("Stats");
  });
});

/**
 * jsdom lays nothing out. Give the tab strip a width and every tab a 100px slot
 * in order, so the bar's own measurement decides what fits. The strip is the
 * element whose children are the tabs; everything else stays unmeasured.
 */
function layOutTabs(room: { width: number }) {
  const slot = (el: HTMLElement) => {
    const tabs = el.parentElement?.querySelectorAll(":scope > [data-tab]");
    return el.dataset.tab && tabs ? Array.prototype.indexOf.call(tabs, el) : -1;
  };
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.querySelector(":scope > [data-tab]") ? room.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return Math.max(0, slot(this)) * 100;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return slot(this) === -1 ? 0 : 100;
  });
}

describe("priority+ overflow", () => {
  const five = [
    { id: "briefing", label: "Briefing" },
    { id: "command", label: "Command Center" },
    { id: "schedules", label: "Scheduler" },
    { id: "health", label: "Health", badge: 4 },
    { id: "budget", label: "Budget" },
  ];

  it("moves the destinations the bar cannot fit to the head of the More menu", async () => {
    layOutTabs({ width: 300 });
    const user = userEvent.setup();
    render(
      <NavBar
        destinations={five}
        overflow={overflow}
        activeId="command"
        live
        onOpenPalette={() => {}}
      />,
    );
    // Three 100px tabs fit a 300px strip; the other two leave the bar.
    for (const name of ["Briefing", "Command Center", "Scheduler"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: /health/i })).toBeNull();
    expect(screen.queryByRole("link", { name: "Budget" })).toBeNull();

    // A count that leaves the bar stays on screen, on the menu that holds it.
    const more = screen.getByRole("button", { name: /more/i });
    expect(more).toHaveTextContent("4");
    await user.click(more);
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Health4", "Budget", "Stats"]);
    expect(items[0]).toHaveAttribute("href", "#/health");
  });

  it("brings them back to the bar when the room grows", () => {
    const room = { width: 300 };
    layOutTabs(room);
    render(
      <NavBar
        destinations={five}
        overflow={overflow}
        activeId="command"
        live
        onOpenPalette={() => {}}
      />,
    );
    expect(screen.queryByRole("link", { name: "Budget" })).toBeNull();
    room.width = 500;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("link", { name: "Budget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /more/i })).not.toHaveTextContent("4");
  });

  it("marks the page you are on in More when its tab is one that left the bar", async () => {
    layOutTabs({ width: 300 });
    const user = userEvent.setup();
    render(
      <NavBar
        destinations={five}
        overflow={overflow}
        activeId="budget"
        live
        onOpenPalette={() => {}}
      />,
    );
    // No tab in the bar claims the page; the menu that now holds it does, and
    // the phone menu still names it.
    expect(screen.queryByRole("link", { current: "page" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /more/i }));
    expect(screen.getByRole("menuitem", { name: "Budget" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: /open the menu/i })).toHaveTextContent("Budget");
  });
});

describe("the active-destination pill", () => {
  it("is one element that moves, not a background on whichever tab is current", () => {
    // The pill used to teleport: a `bg-surface-2` class on the active anchor and
    // nothing in between. A single indicator that slides answers "which tab did I
    // come from?" without the user having to have been watching.
    const { container, rerender } = render(
      <NavBar
        destinations={destinations}
        overflow={overflow}
        activeId="command"
        live
        onOpenPalette={() => {}}
      />,
    );
    const pill = container.querySelector('[aria-hidden="true"].absolute.rounded-md.bg-surface-2');
    expect(pill).not.toBeNull();
    // And the anchors no longer draw it themselves, or there would be two.
    for (const link of screen.getAllByRole("link")) {
      expect(link.className).not.toContain("bg-surface-2");
    }
    rerender(
      <NavBar
        destinations={destinations}
        overflow={overflow}
        activeId="schedules"
        live
        onOpenPalette={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "Scheduler" })).toHaveAttribute("aria-current", "page");
  });

  it("hides itself when no destination is active, rather than parking on the first one", () => {
    const { container } = render(
      <NavBar
        destinations={destinations}
        overflow={overflow}
        activeId="stats"
        live
        onOpenPalette={() => {}}
      />,
    );
    const pill = container.querySelector<HTMLElement>(
      '[aria-hidden="true"].absolute.rounded-md.bg-surface-2',
    );
    expect(pill?.style.opacity).toBe("0");
  });
});
