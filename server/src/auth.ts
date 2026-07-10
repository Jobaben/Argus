import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { chmod } from "node:fs/promises";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { paths } from "./claudeHome.js";
import { readJson } from "./sources/readJson.js";
import { atomicWriteJson } from "./sources/atomicWrite.js";
import { KeyedMutex } from "./mutex.js";

/**
 * Simple, secure admin authentication for the pipeline control surface.
 *
 * Editing or running a pipeline ultimately spawns `claude -p` with the user's
 * full credentials, so those endpoints demand an authenticated admin on top of
 * the host/origin/token layers in security.ts. Design choices, and why:
 *
 *  - The password is never stored or logged: only an scrypt hash (memory-hard
 *    KDF, per-account random salt) is persisted to ~/.claude/argus/auth.json,
 *    chmod 0600. scrypt is Node-built-in — no new dependencies.
 *  - Sessions are 256-bit random bearer tokens delivered as an HttpOnly,
 *    SameSite=Strict cookie, so page scripts can't read them and cross-site
 *    pages can't send them. Only a SHA-256 digest of each token is kept
 *    server-side; the table lives in memory, so a restart logs everyone out
 *    (fail-closed).
 *  - Verification is constant-time, and repeated failures trip a lockout so
 *    the login route can't be brute-forced.
 */

export const SESSION_COOKIE = "argus_session";
/** Sessions expire after 12 hours; the UI just asks the admin to log in again. */
export const SESSION_TTL_MS = 12 * 3600_000;
/** After this many consecutive failures, login locks for LOCKOUT_MS. */
export const MAX_LOGIN_FAILURES = 5;
export const LOCKOUT_MS = 30_000;
export const MIN_PASSWORD_LENGTH = 8;

// Parameters follow the OWASP password-storage recommendation for scrypt
// (N=2^17, r=8, p=1) and are persisted per credential record so they can be
// raised later without invalidating existing hashes.
const SCRYPT = { N: 131072, r: 8, p: 1, keyLen: 64 };

interface CredentialRecord {
  version: 1;
  username: string;
  algorithm: "scrypt";
  /** hex */
  salt: string;
  /** hex */
  hash: string;
  params: { N: number; r: number; p: number; keyLen: number };
  createdAt: string;
  updatedAt: string;
}

export class AuthValidationError extends Error {}

function scrypt(password: string, salt: Buffer, params: typeof SCRYPT): Promise<Buffer> {
  const opts: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    // Node caps scrypt memory at 32 MiB by default; N=2^17,r=8 needs 128 MiB
    // (128·N·r bytes) — allow twice that for headroom.
    maxmem: 128 * params.N * params.r * 2,
  };
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, params.keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time equality over hex strings of possibly different lengths. */
function safeHexEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function validateUsername(username: unknown): string {
  if (typeof username !== "string" || !username.trim()) {
    throw new AuthValidationError("username is required");
  }
  const u = username.trim();
  if (u.length > 64) throw new AuthValidationError("username must be at most 64 characters");
  return u;
}

function validatePassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > 1024) throw new AuthValidationError("password is too long");
  return password;
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: string; username: string }
  | { ok: false; reason: "bad-credentials" | "locked" | "not-configured" };

export interface AuthService {
  /** True once an admin account exists on disk. */
  isConfigured(): Promise<boolean>;
  /** Public shape for the UI: whether setup ran and who is logged in. */
  status(token: string | null): Promise<{ configured: boolean; username: string | null }>;
  /** One-time first-run creation of the admin account. Throws AuthValidationError. */
  setup(username: unknown, password: unknown): Promise<void>;
  login(username: unknown, password: unknown): Promise<LoginResult>;
  /** Returns the session's username, or null for a missing/expired/unknown token. */
  verify(token: string | null | undefined): string | null;
  logout(token: string | null | undefined): void;
}

export function createAuthService(deps: { now?: () => Date } = {}): AuthService {
  const now = deps.now ?? (() => new Date());
  const mutex = new KeyedMutex();
  // token sha256 → session. In-memory by design: restart = logged out.
  const sessions = new Map<string, { username: string; expiresAt: number }>();
  let consecutiveFailures = 0;
  let lockedUntil = 0;

  async function readCredentials(): Promise<CredentialRecord | null> {
    const rec = await readJson<CredentialRecord | null>(paths.authFile(), null);
    if (!rec || rec.algorithm !== "scrypt" || !rec.salt || !rec.hash || !rec.params) return null;
    return rec;
  }

  function pruneExpired(): void {
    const t = now().getTime();
    for (const [key, s] of sessions) if (s.expiresAt <= t) sessions.delete(key);
  }

  function issueSession(username: string): { token: string; expiresAt: string } {
    pruneExpired();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now().getTime() + SESSION_TTL_MS;
    sessions.set(sha256(token), { username, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  function verify(token: string | null | undefined): string | null {
    if (!token) return null;
    pruneExpired();
    return sessions.get(sha256(token))?.username ?? null;
  }

  return {
    isConfigured: async () => (await readCredentials()) !== null,

    async status(token) {
      return { configured: (await readCredentials()) !== null, username: verify(token) };
    },

    async setup(username, password) {
      const u = validateUsername(username);
      const p = validatePassword(password);
      await mutex.withLock("auth", async () => {
        if ((await readCredentials()) !== null) {
          throw new AuthValidationError("admin account already exists");
        }
        const salt = randomBytes(16);
        const hash = await scrypt(p, salt, SCRYPT);
        const at = now().toISOString();
        const record: CredentialRecord = {
          version: 1,
          username: u,
          algorithm: "scrypt",
          salt: salt.toString("hex"),
          hash: hash.toString("hex"),
          params: SCRYPT,
          createdAt: at,
          updatedAt: at,
        };
        await atomicWriteJson(paths.authFile(), record);
        // The record holds only salt+hash, but tighten permissions anyway.
        await chmod(paths.authFile(), 0o600).catch(() => {});
      });
    },

    async login(username, password) {
      const t = now().getTime();
      if (t < lockedUntil) return { ok: false, reason: "locked" };
      const rec = await readCredentials();
      if (!rec) return { ok: false, reason: "not-configured" };

      let valid = false;
      if (typeof username === "string" && typeof password === "string") {
        // Hash even when the username is wrong so both rejections cost the same.
        const derived = await scrypt(password, Buffer.from(rec.salt, "hex"), rec.params);
        const passwordOk = safeHexEqual(derived.toString("hex"), rec.hash);
        const userOk = safeHexEqual(sha256(username), sha256(rec.username));
        valid = passwordOk && userOk;
      }

      if (!valid) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_LOGIN_FAILURES) lockedUntil = t + LOCKOUT_MS;
        return { ok: false, reason: "bad-credentials" };
      }
      consecutiveFailures = 0;
      lockedUntil = 0;
      return { ok: true, username: rec.username, ...issueSession(rec.username) };
    },

    verify,

    logout(token) {
      if (token) sessions.delete(sha256(token));
    },
  };
}

/** Pull the session token off a request: cookie first, explicit header for CLIs. */
export function sessionToken(c: Context): string | null {
  return getCookie(c, SESSION_COOKIE) ?? c.req.header("x-argus-session") ?? null;
}

/**
 * Middleware for admin-only routes (pipeline edit/run). 401s carry a `code`
 * the UI switches on: `auth_setup_required` renders the first-run form,
 * `auth_required` renders the login form.
 */
export function requireAdmin(auth: AuthService) {
  return async (c: Context, next: Next) => {
    if (auth.verify(sessionToken(c))) return next();
    const configured = await auth.isConfigured();
    return c.json(
      configured
        ? { error: "admin login required", code: "auth_required" }
        : {
            error: "no admin account yet — create one to edit or run pipelines",
            code: "auth_setup_required",
          },
      401,
    );
  };
}
