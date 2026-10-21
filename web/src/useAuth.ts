import { useCallback, useEffect } from "react";
import { useLiveResource } from "./live/useLiveResource";

import type { AuthStatus } from "@argus/contracts";

export type { AuthStatus };

export async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(msg.error ?? `HTTP ${res.status}`);
  }
}

/** Fired on `window` after any instance changes the session. */
const AUTH_CHANGED = "argus:auth-changed";
const announceAuthChange = () => window.dispatchEvent(new Event(AUTH_CHANGED));

/**
 * Account session state for the pipeline control surface. The session itself
 * is an HttpOnly cookie the server sets on login/bootstrap — this hook only
 * tracks whether one exists (via /api/auth/status, polled so an expired
 * session is eventually noticed) and exposes the transitions.
 *
 * Every caller holds its own copy of the status, so a sign-in from one page's
 * form used to update that page alone: the nav, the phone header and the
 * palette went on showing a signed-out viewer until the next poll a minute
 * later. A transition here tells every instance to re-read the status instead.
 */
export function useAuth() {
  const { data, loading, error, refresh } = useLiveResource<AuthStatus | null>("/api/auth/status", {
    select: (j) => {
      const body = j as Partial<AuthStatus>;
      return {
        configured: body.configured === true,
        authenticated: body.authenticated === true,
        username: body.username ?? null,
        role: body.role ?? null,
        sessionRequired: body.sessionRequired === true,
      };
    },
    initial: null,
    pollMs: 60_000,
  });

  useEffect(() => {
    const onChange = () => void refresh();
    window.addEventListener(AUTH_CHANGED, onChange);
    return () => window.removeEventListener(AUTH_CHANGED, onChange);
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    await postJson("/api/auth/login", { username, password });
    announceAuthChange();
  }, []);

  const setup = useCallback(async (username: string, password: string) => {
    await postJson("/api/auth/setup", { username, password });
    announceAuthChange();
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    await postJson("/api/auth/register", { username, password });
    announceAuthChange();
  }, []);

  const logout = useCallback(async () => {
    await postJson("/api/auth/logout", {});
    announceAuthChange();
  }, []);

  // Signed in: the one rule for showing an admin control (stop, delete, edit).
  const isAdmin = data?.authenticated === true;

  return { status: data, isAdmin, loading, error, refresh, login, setup, register, logout };
}
