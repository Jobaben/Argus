import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

/** An error answer with the server's JSON reason, as Hono sends one. */
function refused(status: number, error: string) {
  return { ok: false, status, json: async () => ({ error }) } as Response;
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

  it("badges each row in sentence case", async () => {
    mockFetch({
      "/api/auth/status": () => okJson(rootStatus),
      "/api/users": () => okJson({ users: rows }),
    });
    render(<Users />);
    const own = (await screen.findByText("Josha")).closest("li") as HTMLElement;
    expect(within(own).getByText("Root")).toBeInTheDocument();
    expect(within(own).getByText("You")).toBeInTheDocument();
    const alice = screen.getByText("alice").closest("li") as HTMLElement;
    expect(within(alice).getByText("Member")).toBeInTheDocument();
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

  it("asks before rejecting a request, and Keep sends nothing and hands focus back", async () => {
    const user = userEvent.setup();
    const reject = vi.fn(() => okJson({ ok: true }));
    mockFetch({
      "/api/auth/status": () => okJson(rootStatus),
      "/api/users": () => okJson({ users: rows }),
      "/api/users/alice/reject": reject,
    });
    render(<Users />);
    const opener = await screen.findByRole("button", { name: "Reject alice" });
    await user.click(opener);
    expect(opener).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Reject alice's request?" })).toBeVisible();
    // The safe answer takes focus, so an Enter pressed out of habit keeps it.
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("group", { name: /reject alice/i })).toBeNull();
    expect(opener).toHaveFocus();
    expect(reject).not.toHaveBeenCalled();
  });

  it("rejects a request once the question is answered with Reject request", async () => {
    const user = userEvent.setup();
    const reject = vi.fn(() => okJson({ ok: true }));
    mockFetch({
      "/api/auth/status": () => okJson(rootStatus),
      "/api/users": () => okJson({ users: rows }),
      "/api/users/alice/reject": reject,
    });
    render(<Users />);
    await user.click(await screen.findByRole("button", { name: "Reject alice" }));
    expect(reject).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reject request" }));
    await waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
  });

  it("asks before removing an account, and Escape keeps it", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(() => okJson({ ok: true }));
    const bob = { username: "bob", role: "member", status: "active", createdAt: rows[0].createdAt };
    mockFetch({
      "/api/auth/status": () => okJson(rootStatus),
      "/api/users": () => okJson({ users: [...rows, bob] }),
      "/api/users/bob/reject": remove,
    });
    render(<Users />);
    const opener = await screen.findByRole("button", { name: "Remove bob" });
    await user.click(opener);
    const question = screen.getByRole("group", { name: "Remove bob?" });
    // It says what else happens: whoever is signed in as bob is signed out.
    expect(question).toHaveAccessibleDescription(
      "The account is deleted, and anyone signed in as bob is signed out.",
    );
    expect(within(question).getByRole("button", { name: "Keep" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Remove bob?" })).toBeNull();
    expect(opener).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();

    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Remove account" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
  });

  it("says a refused approval on the row it is about, as a sentence", async () => {
    // It used to be a strip at the top of the page reading "Couldn't complete
    // that user is not pending", the subject running into the server's clause.
    mockFetch({
      "/api/auth/status": () => okJson(rootStatus),
      "/api/users": () => okJson({ users: rows }),
      "/api/users/alice/approve": () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({ error: "user is not pending" }),
        }) as Response,
    });
    render(<Users />);
    await userEvent.click(await screen.findByRole("button", { name: /approve alice/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't approve alice: user is not pending");
    expect(alert.closest("li")).toBe(
      screen.getByRole("button", { name: /approve alice/i }).closest("li"),
    );
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
    expect(screen.getByRole("form", { name: "Sign in" })).toBeTruthy();
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
      "/api/users": () => refused(401, "login required"),
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
        // The server's real body: the page must know a refusal by its status,
        // not by the words, which now carry the server's own reason.
        return refused(401, "login required");
      },
    });
    render(<Users />);
    expect(await screen.findByText("Sign in as root to manage accounts")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load users/)).toBeNull();
  });

  it("still reports a list that fails for another reason, with a retry", async () => {
    mockFetch({
      "/api/auth/status": () => okJson(rootStatus),
      "/api/users": () => refused(500, "database is locked"),
    });
    render(<Users />);
    expect(await screen.findByText("Couldn't load users: database is locked")).toBeTruthy();
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
