// web/src/authGate.test.tsx
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

/** Records every path fetched, and answers /api/auth/status with `status`. */
function stubFetch(status: Record<string, unknown>) {
  const paths: string[] = [];
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    paths.push(url);
    const body = url.includes("/api/auth/status") ? status : { agents: [], overview: [] };
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
    });
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return paths;
}

async function mount() {
  await act(async () => {
    render(<App />);
  });
  await act(async () => {});
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  window.location.hash = "#/command";
});

/**
 * A token-gated server refuses every dashboard read from a browser, which has no
 * way to present ARGUS_TOKEN. The gate has to ask for a login *instead of*
 * mounting the dashboard: mounting it and letting the panels fail produces a
 * screen of empty cards over a retrying wall of 401s in the server log.
 */
describe("auth gate", () => {
  it("asks for a login instead of mounting a dashboard that would 401", async () => {
    stubFetch({
      configured: true,
      authenticated: false,
      username: null,
      role: null,
      sessionRequired: true,
    });
    await mount();

    expect(screen.getByRole("form", { name: "Login" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Command Center" })).toBeNull();
  });

  it("makes no data requests while locked out", async () => {
    const paths = stubFetch({
      configured: true,
      authenticated: false,
      username: null,
      role: null,
      sessionRequired: true,
    });
    await mount();

    // The point of gating above the dashboard rather than inside it: the data
    // hooks are never mounted, so their requests are never sent.
    const dataCalls = paths.filter((p) => !p.includes("/api/auth/status"));
    expect(dataCalls).toEqual([]);
  });

  it("mounts the dashboard once a session exists", async () => {
    stubFetch({
      configured: true,
      authenticated: true,
      username: "root",
      role: "root",
      sessionRequired: true,
    });
    await mount();

    expect(screen.getByRole("link", { name: "Command Center" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Login" })).toBeNull();
  });

  it("never gates a server that needs no session", async () => {
    // Loopback with no ARGUS_TOKEN: reads are open and the dashboard has always
    // worked signed out. Gating here would be a regression, not a fix.
    stubFetch({
      configured: true,
      authenticated: false,
      username: null,
      role: null,
      sessionRequired: false,
    });
    await mount();

    expect(screen.getByRole("link", { name: "Command Center" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Login" })).toBeNull();
  });

  it("falls open to the dashboard when auth status cannot be read", async () => {
    // A server that is down is a different problem with its own reporting; a
    // login form would misattribute it and hide the real error.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch,
    );
    await mount();

    expect(screen.queryByRole("form", { name: "Login" })).toBeNull();
  });
});
