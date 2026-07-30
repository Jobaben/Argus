// web/src/App.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
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
    expect(screen.queryByRole("link", { name: "Inventory" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sessions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Activity" })).toBeNull();
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
});
