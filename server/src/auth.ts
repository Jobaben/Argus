import { createHash, randomBytes } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import {
  createUserStore,
  verifyPassword,
  dummyVerify,
  type Role,
  type UserStore,
} from "./userStore.js";

// Existing importers (app.ts, tests) get these from here.
export { AuthValidationError, MIN_PASSWORD_LENGTH } from "./userStore.js";

/**
 * Session management for the pipeline control surface.
 *
 * Editing or running a pipeline ultimately spawns `claude -p` with the user's
 * full credentials, so those endpoints demand an authenticated account on top
 * of the host/origin/token layers in security.ts. Accounts themselves —
 * registration, root approval, scrypt hashing — live in userStore.ts; this
 * module only turns valid credentials into sessions:
 *
 *  - Sessions are 256-bit random bearer tokens delivered as an HttpOnly,
 *    SameSite=Strict cookie, so page scripts can't read them and cross-site
 *    pages can't send them. Only a SHA-256 digest of each token is kept
 *    server-side; the table lives in memory, so a restart logs everyone out
 *    (fail-closed). Each session carries the account's role.
 *  - Verification is constant-time, and repeated failures trip a global
 *    lockout so the login route can't be brute-forced. Unknown usernames burn
 *    the same KDF cost as real ones, so timing doesn't reveal who exists.
 */

export const SESSION_COOKIE = "argus_session";
/** Sessions expire after 12 hours; the UI just asks the user to log in again. */
export const SESSION_TTL_MS = 12 * 3600_000;
/** After this many consecutive failures, login locks for LOCKOUT_MS. */
export const MAX_LOGIN_FAILURES = 5;
export const LOCKOUT_MS = 30_000;

export interface SessionInfo {
  username: string;
  role: Role;
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: string; username: string; role: Role }
  | { ok: false; reason: "bad-credentials" | "locked" | "not-configured" | "pending-approval" };

export interface AuthService {
  /** True once at least one account exists. */
  isConfigured(): Promise<boolean>;
  /** Public shape for the UI: whether any account exists and who is logged in. */
  status(
    token: string | null,
  ): Promise<{ configured: boolean; username: string | null; role: Role | null }>;
  login(username: unknown, password: unknown): Promise<LoginResult>;
  /** Returns the session's identity, or null for a missing/expired/unknown token. */
  verify(token: string | null | undefined): SessionInfo | null;
  logout(token: string | null | undefined): void;
  /** Kill every live session for a user — called when root rejects/removes them. */
  revokeSessions(username: string): void;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createAuthService(
  deps: { store?: UserStore; now?: () => Date } = {},
): AuthService {
  const store = deps.store ?? createUserStore();
  const now = deps.now ?? (() => new Date());
  // token sha256 → session. In-memory by design: restart = logged out.
  const sessions = new Map<string, SessionInfo & { expiresAt: number }>();
  let consecutiveFailures = 0;
  let lockedUntil = 0;

  function pruneExpired(): void {
    const t = now().getTime();
    for (const [key, s] of sessions) if (s.expiresAt <= t) sessions.delete(key);
  }

  function issueSession(info: SessionInfo): { token: string; expiresAt: string } {
    pruneExpired();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now().getTime() + SESSION_TTL_MS;
    sessions.set(sha256(token), { ...info, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  function verify(token: string | null | undefined): SessionInfo | null {
    if (!token) return null;
    pruneExpired();
    const s = sessions.get(sha256(token));
    return s ? { username: s.username, role: s.role } : null;
  }

  return {
    isConfigured: async () => (await store.count()) > 0,

    async status(token) {
      const session = verify(token);
      return {
        configured: (await store.count()) > 0,
        username: session?.username ?? null,
        role: session?.role ?? null,
      };
    },

    async login(username, password) {
      const t = now().getTime();
      if (t < lockedUntil) return { ok: false, reason: "locked" };
      if ((await store.count()) === 0) return { ok: false, reason: "not-configured" };

      const rec = typeof username === "string" ? await store.find(username) : null;
      let valid = false;
      if (typeof password === "string") {
        // Unknown usernames burn the same KDF cost so both rejections look alike.
        if (rec) valid = await verifyPassword(rec, password);
        else await dummyVerify(password);
      }

      if (!valid || !rec) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_LOGIN_FAILURES) lockedUntil = t + LOCKOUT_MS;
        return { ok: false, reason: "bad-credentials" };
      }
      consecutiveFailures = 0;
      lockedUntil = 0;
      if (rec.status === "pending") return { ok: false, reason: "pending-approval" };
      return {
        ok: true,
        username: rec.username,
        role: rec.role,
        ...issueSession({ username: rec.username, role: rec.role }),
      };
    },

    verify,

    logout(token) {
      if (token) sessions.delete(sha256(token));
    },

    revokeSessions(username) {
      for (const [key, s] of sessions) {
        if (s.username.toLowerCase() === username.toLowerCase()) sessions.delete(key);
      }
    },
  };
}

/** Pull the session token off a request: cookie first, explicit header for CLIs. */
export function sessionToken(c: Context): string | null {
  return getCookie(c, SESSION_COOKIE) ?? c.req.header("x-argus-session") ?? null;
}

/**
 * Middleware for routes any active account may use (pipeline edit/run).
 * 401s carry a `code` the UI switches on: `auth_setup_required` renders the
 * first-run form, `auth_required` renders the login form.
 */
export function requireAdmin(auth: AuthService) {
  return async (c: Context, next: Next) => {
    if (auth.verify(sessionToken(c))) return next();
    const configured = await auth.isConfigured();
    return c.json(
      configured
        ? { error: "login required", code: "auth_required" }
        : {
            error: "no account yet — create one to edit or run pipelines",
            code: "auth_setup_required",
          },
      401,
    );
  };
}

/** Middleware for root-only routes (user administration). */
export function requireRoot(auth: AuthService) {
  return async (c: Context, next: Next) => {
    const session = auth.verify(sessionToken(c));
    if (!session) return c.json({ error: "login required", code: "auth_required" }, 401);
    if (session.role !== "root") return c.json({ error: "root privileges required" }, 403);
    return next();
  };
}
