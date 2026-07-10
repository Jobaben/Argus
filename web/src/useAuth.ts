import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";

export interface AuthStatus {
  /** Whether an admin account has been created (first-run setup done). */
  configured: boolean;
  authenticated: boolean;
  username: string | null;
}

async function postJson(path: string, body: unknown): Promise<void> {
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

/**
 * Admin session state for the pipeline control surface. The session itself is
 * an HttpOnly cookie the server sets on login/setup — this hook only tracks
 * whether one exists (via /api/auth/status, polled so an expired session is
 * eventually noticed) and exposes the transitions.
 */
export function useAuth() {
  const { data, loading, error, refresh } = useLiveResource<AuthStatus | null>("/api/auth/status", {
    select: (j) => {
      const body = j as Partial<AuthStatus>;
      return {
        configured: body.configured === true,
        authenticated: body.authenticated === true,
        username: body.username ?? null,
      };
    },
    initial: null,
    pollMs: 60_000,
  });

  const login = useCallback(
    async (username: string, password: string) => {
      await postJson("/api/auth/login", { username, password });
      refresh();
    },
    [refresh],
  );

  const setup = useCallback(
    async (username: string, password: string) => {
      await postJson("/api/auth/setup", { username, password });
      refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await postJson("/api/auth/logout", {});
    refresh();
  }, [refresh]);

  return { status: data, loading, error, refresh, login, setup, logout };
}
