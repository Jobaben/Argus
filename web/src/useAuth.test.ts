import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAuth } from "./useAuth";

/**
 * A server with one account. Signing in or out flips the session the status
 * endpoint reports, as the cookie would.
 */
function serveAuth() {
  let signedIn = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/auth/login") signedIn = true;
      if (url === "/api/auth/logout") signedIn = false;
      const body =
        url === "/api/auth/status"
          ? {
              configured: true,
              authenticated: signedIn,
              username: signedIn ? "ops" : null,
              role: signedIn ? "root" : null,
              sessionRequired: false,
            }
          : {};
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }) as unknown as typeof fetch,
  );
}

beforeEach(serveAuth);
afterEach(() => vi.unstubAllGlobals());

describe("useAuth", () => {
  it("updates every holder of the status when one of them signs in or out", async () => {
    // A page's own sign-in form and the shell each hold a copy. Signing in from
    // the page used to leave the shell's nav and palette signed out for a minute.
    const page = renderHook(() => useAuth());
    const shell = renderHook(() => useAuth());
    await waitFor(() => expect(shell.result.current.status?.authenticated).toBe(false));

    await act(() => page.result.current.login("ops", "secret"));
    await waitFor(() => expect(shell.result.current.status?.role).toBe("root"));
    expect(page.result.current.status?.authenticated).toBe(true);

    await act(() => page.result.current.logout());
    await waitFor(() => expect(shell.result.current.status?.authenticated).toBe(false));
  });
});
