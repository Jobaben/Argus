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

  it("opens the sign-in form in place for a signed-out reader", async () => {
    // The form used to live on the Pipelines tab, and this page only pointed
    // there; now the empty state's action is the form.
    const user = userEvent.setup();
    const spy = mockFetch({
      "/api/auth/status": () =>
        okJson({ configured: true, authenticated: false, username: null, role: null }),
    });
    render(<Users />);
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("form", { name: /^login$/i })).toBeTruthy();
    expect(screen.getByLabelText("Username")).toHaveFocus();
    // The form says what the account is for here, not on the Pipelines page.
    expect(screen.getByText(/managing accounts is for the root user/i)).toBeTruthy();
    expect(screen.queryByText(/pipelines/i)).toBeNull();
    // The account list is root's; nobody else is made to ask for it.
    expect(spy.mock.calls.some(([input]) => String(input).includes("/api/users"))).toBe(false);
  });

  it("offers the first account on an empty install, rather than a 401", async () => {
    // `/api/users` is root-only: on an install with no accounts it can only
    // answer 401, which this page used to print as a load error.
    const user = userEvent.setup();
    const spy = mockFetch({
      "/api/auth/status": () =>
        okJson({ configured: false, authenticated: false, username: null, role: null }),
      "/api/users": () => ({ ok: false, status: 401, json: async () => ({}) }) as Response,
    });
    render(<Users />);
    expect(await screen.findByText("No root account yet")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load users/)).toBeNull();
    expect(screen.queryByText(/HTTP 401/)).toBeNull();
    expect(spy.mock.calls.some(([input]) => String(input).includes("/api/users"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Create the root account" }));
    expect(screen.getByRole("form", { name: /create the root account/i })).toBeTruthy();
  });

  it("turns a session that ended under the page into the sign-in state, not an error", async () => {
    // Root's session expires between two reads of the status: the list answers
    // 401. That is a signed-out reader, and the page says so.
    let signedIn = true;
    mockFetch({
      "/api/auth/status": () =>
        okJson(
          signedIn
            ? rootStatus
            : { configured: true, authenticated: false, username: null, role: null },
        ),
      "/api/users": () => {
        signedIn = false;
        return { ok: false, status: 401, json: async () => ({}) } as Response;
      },
    });
    render(<Users />);
    expect(await screen.findByText("Sign in as root to manage accounts")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load users/)).toBeNull();
  });

  it("still reports a list that fails for another reason, with a retry", async () => {
    mockFetch({
      "/api/auth/status": () => okJson(rootStatus),
      "/api/users": () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    });
    render(<Users />);
    expect(await screen.findByText(/Couldn't load users: HTTP 500/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("tells a signed-in non-root user why they cannot act, with no dead link", async () => {
    mockFetch({
      "/api/auth/status": () =>
        okJson({ configured: true, authenticated: true, username: "sam", role: "member" }),
      "/api/users": () => okJson({ users: [] }),
    });
    render(<Users />);
    await waitFor(() =>
      expect(screen.getByText("Only the root user can manage accounts")).toBeTruthy(),
    );
    expect(screen.queryByRole("link", { name: /Sign in/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
  });
});
