import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { chmod } from "node:fs/promises";
import { paths } from "./claudeHome.js";
import { readJson } from "./sources/readJson.js";
import { atomicWriteJson } from "./sources/atomicWrite.js";
import { KeyedMutex } from "./mutex.js";

/**
 * Multi-user account store for the pipeline control surface.
 *
 * Owns the full user lifecycle — self-registration (pending), root approval,
 * removal — and everything password-shaped: scrypt hashing (memory-hard KDF,
 * per-user random salt, OWASP params), verification, and the dummy hash used
 * to keep unknown-username logins timing-identical. Sessions and lockout stay
 * in auth.ts; this module never sees a token.
 *
 * Persistence is a single users.json (chmod 0600, atomic writes). The legacy
 * single-admin auth.json migrates on first read: that account becomes the
 * root user, closing the door it used to guard without a manual step.
 */

export type Role = "root" | "member";
export type UserStatus = "pending" | "active";

export const MIN_PASSWORD_LENGTH = 8;

// OWASP password-storage recommendation for scrypt; persisted per record so
// they can be raised later without invalidating existing hashes.
const SCRYPT = { N: 131072, r: 8, p: 1, keyLen: 64 };

export class AuthValidationError extends Error {}
export class DuplicateUsernameError extends AuthValidationError {}
export class UnknownUserError extends Error {}

export interface UserRecord {
  username: string;
  role: Role;
  status: UserStatus;
  algorithm: "scrypt";
  /** hex */
  salt: string;
  /** hex */
  hash: string;
  params: { N: number; r: number; p: number; keyLen: number };
  createdAt: string;
  updatedAt: string;
}

export interface UserSummary {
  username: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
}

interface UsersFile {
  version: 2;
  users: UserRecord[];
}

/** Shape written by the retired single-admin AuthService. */
interface LegacyRecord {
  version: 1;
  username: string;
  algorithm: "scrypt";
  salt: string;
  hash: string;
  params: { N: number; r: number; p: number; keyLen: number };
  createdAt: string;
  updatedAt: string;
}

export interface UserStore {
  list(): Promise<UserSummary[]>;
  /** Case-insensitive lookup. */
  find(username: string): Promise<UserRecord | null>;
  count(): Promise<number>;
  /** Validates and hashes; defaults to a pending member. Throws AuthValidationError. */
  register(
    username: unknown,
    password: unknown,
    opts?: { role?: Role; status?: UserStatus },
  ): Promise<void>;
  /** pending → active. Throws UnknownUserError. */
  approve(username: string): Promise<void>;
  /** Deletes the record (reject or revoke). Throws UnknownUserError. */
  remove(username: string): Promise<void>;
}

function scrypt(
  password: string,
  salt: Buffer,
  params: typeof SCRYPT,
): Promise<Buffer> {
  const opts: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    // Node caps scrypt memory at 32 MiB by default; N=2^17,r=8 needs 128 MiB
    // (128·N·r bytes) — allow twice that for headroom.
    maxmem: 128 * params.N * params.r * 2,
  };
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, params.keyLen, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
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

export async function verifyPassword(rec: UserRecord, password: string): Promise<boolean> {
  const derived = await scrypt(password, Buffer.from(rec.salt, "hex"), rec.params);
  return safeHexEqual(derived.toString("hex"), rec.hash);
}

const DUMMY_SALT = Buffer.alloc(16);

/** Burn the same KDF cost as a real check so unknown usernames don't return faster. */
export async function dummyVerify(password: string): Promise<void> {
  await scrypt(password, DUMMY_SALT, SCRYPT);
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
    throw new AuthValidationError(
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if (password.length > 1024) throw new AuthValidationError("password is too long");
  return password;
}

export function createUserStore(deps: { now?: () => Date } = {}): UserStore {
  const now = deps.now ?? (() => new Date());
  const mutex = new KeyedMutex();

  async function persist(file: UsersFile): Promise<void> {
    await atomicWriteJson(paths.usersFile(), file);
    // Records hold only salts+hashes, but tighten permissions anyway.
    await chmod(paths.usersFile(), 0o600).catch(() => {});
  }

  /** Load users.json, migrating the legacy single-admin auth.json once. */
  async function load(): Promise<UsersFile> {
    const file = await readJson<UsersFile | null>(paths.usersFile(), null);
    if (file && file.version === 2 && Array.isArray(file.users)) return file;

    const legacy = await readJson<LegacyRecord | null>(paths.authFile(), null);
    if (legacy && legacy.algorithm === "scrypt" && legacy.salt && legacy.hash && legacy.params) {
      const migrated: UsersFile = {
        version: 2,
        users: [
          {
            username: legacy.username,
            role: "root",
            status: "active",
            algorithm: "scrypt",
            salt: legacy.salt,
            hash: legacy.hash,
            params: legacy.params,
            createdAt: legacy.createdAt,
            updatedAt: legacy.updatedAt,
          },
        ],
      };
      await persist(migrated);
      return migrated;
    }
    return { version: 2, users: [] };
  }

  const byName = (users: UserRecord[], username: string): UserRecord | undefined =>
    users.find((u) => u.username.toLowerCase() === username.toLowerCase());

  return {
    list: () =>
      mutex.withLock("users", async () =>
        (await load()).users.map(({ username, role, status, createdAt }) => ({
          username,
          role,
          status,
          createdAt,
        })),
      ),

    find: (username) =>
      mutex.withLock("users", async () => byName((await load()).users, username) ?? null),

    count: () => mutex.withLock("users", async () => (await load()).users.length),

    async register(username, password, opts = {}) {
      const u = validateUsername(username);
      const p = validatePassword(password);
      // Hash outside the lock: the KDF deliberately takes ~100 ms.
      const salt = randomBytes(16);
      const hash = await scrypt(p, salt, SCRYPT);
      await mutex.withLock("users", async () => {
        const file = await load();
        if (byName(file.users, u)) {
          throw new DuplicateUsernameError("username is already taken");
        }
        const at = now().toISOString();
        file.users.push({
          username: u,
          role: opts.role ?? "member",
          status: opts.status ?? "pending",
          algorithm: "scrypt",
          salt: salt.toString("hex"),
          hash: hash.toString("hex"),
          params: SCRYPT,
          createdAt: at,
          updatedAt: at,
        });
        await persist(file);
      });
    },

    approve: (username) =>
      mutex.withLock("users", async () => {
        const file = await load();
        const rec = byName(file.users, username);
        if (!rec) throw new UnknownUserError("no such user");
        rec.status = "active";
        rec.updatedAt = now().toISOString();
        await persist(file);
      }),

    remove: (username) =>
      mutex.withLock("users", async () => {
        const file = await load();
        if (!byName(file.users, username)) throw new UnknownUserError("no such user");
        file.users = file.users.filter(
          (u) => u.username.toLowerCase() !== username.toLowerCase(),
        );
        await persist(file);
      }),
  };
}
