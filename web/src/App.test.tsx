// web/src/App.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ agents: [], overview: [] }) }),
    ) as unknown as typeof fetch,
  );
  window.location.hash = "#/command";
});

describe("App shell", () => {
  it("renders a single nav with the two destinations and no monitoring strip", async () => {
    await act(async () => {
      render(<App />);
    });
    await act(async () => {});
    expect(screen.getByRole("link", { name: "Command Center" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Scheduler" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Health" })).toBeInTheDocument();
    // Folded into Scheduler and Health respectively — no tab of their own.
    expect(screen.queryByRole("link", { name: "Launch" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Monitors" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Watchtower" })).toBeNull();
    // Overflow and removed routes are not in the bar.
    expect(screen.queryByRole("link", { name: "Inventory" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sentinel" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Activity" })).toBeNull();
  });

  it("rewrites a legacy hash to where its content went, without a history entry", async () => {
    window.location.hash = "#/monitors";
    await act(async () => {
      render(<App />);
    });
    await act(async () => {});
    expect(window.location.hash).toBe("#/health");
    expect(await screen.findByRole("heading", { name: "Health" })).toBeInTheDocument();
  });
});

/**
 * The direction published on `<html data-route>` is what `index.css` selects the
 * view-transition animation on, so getting it wrong animates a drill-down as a
 * step back — a lie about the structure, told exactly when the user is relying on
 * it to know where they are.
 */
describe("route direction", () => {
  async function mount() {
    await act(async () => {
      render(<App />);
    });
    await act(async () => {});
  }

  /**
   * `replaceState` rather than assigning `location.hash`, because jsdom fires its
   * own `hashchange` on assignment — and it queues it, so two assignments in a row
   * deliver two events that both read the *final* hash. That artifact would hide
   * the very thing the second test is about. `replaceState` moves the hash without
   * firing, leaving the dispatch explicit and one event per navigation.
   */
  function goto(hash: string) {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  it("reads forward going deeper and back coming out", async () => {
    await mount();
    await act(async () => goto("#/agent/abc"));
    expect(document.documentElement.dataset.route).toBe("forward");
    await act(async () => goto("#/command"));
    expect(document.documentElement.dataset.route).toBe("back");
  });

  it("keeps peer destinations lateral — that is not a hierarchy move", async () => {
    await mount();
    await act(async () => goto("#/budget"));
    expect(document.documentElement.dataset.route).toBe("lateral");
  });

  it("measures from the route it last saw, not the one React last rendered", async () => {
    // Where View Transitions exist the browser calls the update callback *later* —
    // it snapshots first — so no render, and therefore no re-registered listener,
    // sits between two quick navigations. The origin has to come from something the
    // handler updates synchronously; read off the rendered route instead, the
    // second navigation still measures from `#/command` and calls a step back out
    // of a drill-down "lateral", animating a retreat as a sideways move.
    //
    // jsdom has no `startViewTransition`, so without this stub every update is
    // flushed synchronously and the staleness cannot show itself at all.
    const deferred: (() => void)[] = [];
    // Typed as always present by the DOM lib and absent in jsdom, so the stub goes
    // on through a shape that admits both — the same runtime/type gap
    // `supportsViewTransitions()` exists to paper over.
    type Deferrable = { startViewTransition?: (cb: () => void) => unknown };
    const doc = document as unknown as Deferrable;
    const original = doc.startViewTransition;
    doc.startViewTransition = (cb: () => void) => {
      deferred.push(cb);
      return { finished: Promise.resolve() };
    };
    try {
      await mount();
      await act(async () => {
        goto("#/agent/abc");
        goto("#/command");
      });
      expect(document.documentElement.dataset.route).toBe("back");

      // The deferred updates still have to land, in order.
      await act(async () => {
        for (const update of deferred) update();
      });
      expect(screen.getByRole("link", { name: "Command Center" })).toBeInTheDocument();
    } finally {
      doc.startViewTransition = original;
    }
  });

  it("does not start a view transition for a hash change within the same view", async () => {
    // Opening a gate deep link (`#/command/<instance>`) and closing it again both
    // change the hash without changing the view. A transition there crossfades
    // the page into itself and hands hit-testing to the snapshot meanwhile.
    type Deferrable = { startViewTransition?: (cb: () => void) => unknown };
    const doc = document as unknown as Deferrable;
    const original = doc.startViewTransition;
    const started = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    doc.startViewTransition = started;
    try {
      await mount();
      await act(async () => goto("#/command/some-instance"));
      await act(async () => goto("#/command"));
      expect(started).not.toHaveBeenCalled();
      expect(screen.getByRole("link", { name: "Command Center" })).toBeInTheDocument();

      // A genuine route change still transitions.
      await act(async () => goto("#/agent/abc"));
      expect(started).toHaveBeenCalledTimes(1);
    } finally {
      doc.startViewTransition = original;
    }
  });
});

async function mountApp() {
  await act(async () => {
    render(<App />);
  });
  await act(async () => {});
}

/** One navigation, one `hashchange` (see `goto` under "route direction"). */
function navigate(hash: string) {
  window.history.replaceState(null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

describe("the phone menu names the page", () => {
  it("on a drill-down with no tab of its own", async () => {
    window.location.hash = "#/agents";
    await mountApp();
    expect(screen.getByRole("button", { name: /open the menu/i })).toHaveTextContent("Agents");
  });

  it("on Users for a viewer who is not root, and More marks it as the current page", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/users";
    await mountApp();
    expect(screen.getByRole("button", { name: /open the menu/i })).toHaveTextContent("Users");
    await user.click(screen.getByRole("button", { name: /more/i }));
    expect(screen.getByRole("menuitem", { name: "Users" })).toHaveAttribute("aria-current", "page");
  });

  it("names the agent page Agent, not Detail", async () => {
    window.location.hash = "#/agent/abc";
    await mountApp();
    expect(screen.getByRole("button", { name: /open the menu/i })).toHaveTextContent("Agent");
    expect(screen.getByRole("button", { name: /open the menu/i })).not.toHaveTextContent("Detail");
  });
});

describe("the command palette", () => {
  it("reaches Agents, which has no tab", async () => {
    const user = userEvent.setup();
    await mountApp();
    await user.click(screen.getByRole("button", { name: /command palette/i }));
    await user.type(await screen.findByRole("combobox"), "agents");
    expect(await screen.findByRole("option", { name: /^Agents/ })).toBeInTheDocument();
  });
});

describe("arriving on a new view", () => {
  const main = () => screen.getByRole("main");

  it("takes focus to the page when the link that navigated is gone", async () => {
    await mountApp();
    // An in-page link that changes the view is unmounted with it; focus is
    // left on the body.
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => navigate("#/health"));
    expect(main()).toHaveFocus();
  });

  it("leaves focus on the nav tab that was used, which is still there", async () => {
    await mountApp();
    const tab = screen.getByRole("link", { name: "Health" });
    tab.focus();
    await act(async () => navigate("#/health"));
    expect(tab).toHaveFocus();
  });

  it("does not take focus on load or on a hash change within the same view", async () => {
    await mountApp();
    expect(main()).not.toHaveFocus();
    await act(async () => navigate("#/command/some-instance"));
    expect(main()).not.toHaveFocus();
  });

  it("says the new page's name in a polite live region", async () => {
    const said = () =>
      Array.from(document.querySelectorAll('[aria-live="polite"]'), (r) => r.textContent);
    await mountApp();
    expect(said()).toContain("Command Center");
    await act(async () => navigate("#/health"));
    expect(said()).toContain("Health");
    expect(said()).not.toContain("Command Center");
  });
});

describe("the sign-in wall", () => {
  function serve(status: object) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(url === "/api/auth/status" ? status : {}),
        }),
      ) as unknown as typeof fetch,
    );
  }

  it("asks for the first account, not a sign-in, on a server with none", async () => {
    serve({ sessionRequired: true, configured: false, authenticated: false });
    await mountApp();
    expect(
      await screen.findByText("Create the first account to see the dashboard."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Sign in to see the dashboard/)).toBeNull();
  });

  it("asks for a sign-in once accounts exist", async () => {
    serve({ sessionRequired: true, configured: true, authenticated: false });
    await mountApp();
    expect(
      await screen.findByText("This server requires an account. Sign in to see the dashboard."),
    ).toBeInTheDocument();
  });

  it("opens with the form focused, titled as the heading under the wordmark", async () => {
    serve({ sessionRequired: true, configured: true, authenticated: false });
    await mountApp();
    // The form is the whole page, so the first field takes the caret on
    // arrival, and the outline runs h1 then h2 with no level skipped.
    expect(await screen.findByRole("heading", { level: 2, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveFocus();
  });
});
