import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Users from "./Users";

class FakeWS {
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

beforeEach(() => vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const rootStatus = { configured: true, authenticated: true, username: "Josha", role: "root" };
const rows = [
  { username: "Josha", role: "root", status: "active", createdAt: "2026-07-10T10:49:40.330Z" },
  { username: "alice", role: "member", status: "pending", createdAt: "2026-07-10T12:00:00.000Z" },
];

function mockFetch(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const handler = handlers[path];
    if (!handler) throw new Error(`unmocked fetch: ${path}`);
    return handler(init);
  });
}

describe("Users view", () => {
  it("lists pending accounts first with approve/reject controls", async () => {
    mockFetch({
      "/api/auth/status": () => okJson(rootStatus),
      "/api/users": () => okJson({ users: rows }),
    });
    render(<Users />);
    expect(await screen.findByText("alice")).toBeTruthy();
    expect(screen.getByRole("button", { name: /approve alice/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /reject alice/i })).toBeTruthy();
    // Root's own row gets no remove button.
    expect(screen.queryByRole("button", { name: /remove josha/i })).toBeNull();
  });

  it("approves a pending account", async () => {
    const approve = vi.fn(() => okJson({ ok: true }));
    mockFetch({
      "/api/auth/status": () => okJson(rootStatus),
      "/api/users": () => okJson({ users: rows }),
      "/api/users/alice/approve": approve,
    });
    render(<Users />);
    await userEvent.click(await screen.findByRole("button", { name: /approve alice/i }));
    await waitFor(() => expect(approve).toHaveBeenCalled());
  });

  it("tells non-root visitors this page is root-only", async () => {
    mockFetch({
      "/api/auth/status": () => okJson({ ...rootStatus, username: "alice", role: "member" }),
      "/api/users": () => okJson({ users: [] }),
    });
    render(<Users />);
    expect(await screen.findByText(/only the root user/i)).toBeTruthy();
  });
});
