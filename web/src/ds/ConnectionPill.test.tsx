import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionPill } from "./ConnectionPill";

let sockets: FakeWS[] = [];
class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  open() {
    this.onopen?.();
  }
  close() {
    this.onclose?.();
  }
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ConnectionPill", () => {
  it("shows Live when connected", () => {
    render(<ConnectionPill live />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAccessibleName(/connected/i);
  });

  it("says Offline — not an indefinite 'reconnecting' — when down", () => {
    render(<ConnectionPill live={false} />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("counts down to the next attempt, so the wait is explained", () => {
    vi.useFakeTimers();
    render(<ConnectionPill live={false} />);
    // Losing the socket schedules a backoff, which the pill surfaces.
    act(() => {
      sockets[0].open();
      sockets[0].close();
    });
    expect(screen.getByText(/retrying in \ds/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAccessibleName(/retrying in \d+ seconds/i);
  });

  it("offers a manual retry that reconnects without waiting out the backoff", async () => {
    const user = userEvent.setup();
    render(<ConnectionPill live={false} />);
    act(() => {
      sockets[0].open();
      sockets[0].close();
    });
    expect(sockets.length).toBe(1);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    // A fresh socket immediately, rather than after the scheduled delay.
    expect(sockets.length).toBe(2);
  });

  it("offers no retry control while connected", () => {
    render(<ConnectionPill live />);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});
