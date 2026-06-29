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
      Promise.resolve({ ok: true, json: () => Promise.resolve({ agents: [] }) }),
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
