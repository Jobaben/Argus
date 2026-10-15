import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";

/**
 * `server.lock`: one Argus server per state directory, whichever port it uses.
 *
 * Two servers over the same `~/.claude/argus` would both reconcile and launch
 * the same instances, and the Decision Ledger's mutexes are in-process only, so
 * this file is the one cross-process guard either has. It covers servers only:
 * an out-of-process script that writes the stores bypasses it, so such scripts
 * go through the API while a server runs.
 */

export const STATE_LOCK_FILE = "server.lock";

/** A fresh lock is held without asking its server: it may still be starting. */
export const STATE_LOCK_GRACE_MS = 60_000;

export interface StateLockRecord {
  pid: number;
  port: number;
  /** The holder's own address (`selfBaseUrl`), which is what a probe must hit:
   *  a server bound to a LAN address refuses a loopback probe. */
  url: string;
  claudeHome: string;
  build: string | null;
  startedAt: string;
}

/** What the holder's `/api/health` said. */
export type HolderProbe =
  | { kind: "same-home" }
  | { kind: "other-home"; claudeHome: string }
  /** Nothing listens at the holder's address. */
  | { kind: "refused" }
  /** 401, a timeout, any other answer: it cannot be ruled out (decision 4). */
  | { kind: "unconfirmed"; reason: string };

export type HolderVerdict = { held: true; reason: string } | { held: false; reason: string };

/**
 * Whether an existing lock still belongs to a live server on this state.
 * Anything that cannot be confirmed either way counts as held: refusing a
 * second server costs a manual step, while two servers corrupt state.
 */
export async function judgeHolder(input: {
  record: StateLockRecord | null;
  selfPid: number;
  alive: boolean;
  ageMs: number;
  probe: () => Promise<HolderProbe>;
}): Promise<HolderVerdict> {
  const { record, selfPid, alive, ageMs } = input;
  if (record === null) {
    // Created but not yet written, or torn by a crash mid-write.
    return ageMs < STATE_LOCK_GRACE_MS
      ? { held: true, reason: "the lock file is being written" }
      : { held: false, reason: "the lock file is unreadable and older than the grace period" };
  }
  if (record.pid === selfPid) return { held: false, reason: "the lock names this process's pid" };
  if (!alive) return { held: false, reason: `pid ${record.pid} is not running` };
  if (ageMs < STATE_LOCK_GRACE_MS) return { held: true, reason: "the holder is still starting" };
  const p = await input.probe();
  switch (p.kind) {
    case "same-home":
      return { held: true, reason: `the server at ${record.url} serves this state` };
    case "other-home":
      return { held: false, reason: `${record.url} serves ${p.claudeHome}, not this state` };
    case "refused":
      return {
        held: false,
        reason: `nothing listens at ${record.url} (pid ${record.pid} was reused)`,
      };
    case "unconfirmed":
      return {
        held: true,
        reason: `pid ${record.pid} is alive and ${record.url} could not be ruled out (${p.reason})`,
      };
  }
}

/**
 * Whether two spellings name one directory. "Other home" is the one verdict
 * that lets a second server past a live holder, so it must not come from a
 * spelling difference: Windows paths differ by case and 8.3 short names
 * (`MTRUSH~1`). Null when either cannot be resolved, which counts as held.
 */
export function sameDirectory(a: string, b: string): boolean | null {
  let ra: string;
  let rb: string;
  try {
    ra = realpathSync.native(a);
    rb = realpathSync.native(b);
  } catch {
    return null;
  }
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** Asks the holder's `/api/health` which state it serves. Without a token a
 *  token-gated holder answers 401, which counts as unconfirmed (held). */
export async function probeHolder(
  record: StateLockRecord,
  claudeHome: string,
  token: string | null,
  timeoutMs = 3000,
): Promise<HolderProbe> {
  try {
    const res = await fetch(`${record.url}/api/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { kind: "unconfirmed", reason: `health answered ${res.status}` };
    const body = (await res.json().catch(() => null)) as { claudeHome?: unknown } | null;
    if (typeof body?.claudeHome !== "string")
      return { kind: "unconfirmed", reason: "health did not report a claudeHome" };
    const same = sameDirectory(body.claudeHome, claudeHome);
    if (same === null)
      return { kind: "unconfirmed", reason: `cannot resolve ${body.claudeHome} to compare` };
    return same ? { kind: "same-home" } : { kind: "other-home", claudeHome: body.claudeHome };
  } catch (e) {
    const code = (e as { cause?: { code?: unknown } }).cause?.code;
    if (code === "ECONNREFUSED") return { kind: "refused" };
    return { kind: "unconfirmed", reason: code ? String(code) : (e as Error).name };
  }
}

export interface StateLockDeps {
  /** The state directory (`paths.argus()`); created if missing. */
  dir: string;
  isAlive: (pid: number) => boolean;
  probe: (record: StateLockRecord) => Promise<HolderProbe>;
  now: () => Date;
  pid: number;
}

export type AcquireResult =
  | { acquired: true; file: string; record: StateLockRecord; release: () => void }
  | { acquired: false; file: string; holder: StateLockRecord | null; reason: string };

function parseRecord(text: string): StateLockRecord | null {
  try {
    const r = JSON.parse(text) as Partial<StateLockRecord>;
    return typeof r.pid === "number" && typeof r.url === "string" && typeof r.startedAt === "string"
      ? (r as StateLockRecord)
      : null;
  } catch {
    return null;
  }
}

async function readExisting(
  file: string,
): Promise<{ text: string; record: StateLockRecord | null; mtimeMs: number } | null> {
  try {
    const [text, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return { text, record: parseRecord(text), mtimeMs: st.mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Takes the lock, or reports who holds it. A stale lock is replaced only if it
 * still has the content that was judged, so two servers racing over the same
 * stale file cannot both win.
 */
export async function acquireStateLock(
  record: Omit<StateLockRecord, "pid" | "startedAt">,
  deps: StateLockDeps,
): Promise<AcquireResult> {
  const file = path.join(deps.dir, STATE_LOCK_FILE);
  await mkdir(deps.dir, { recursive: true });
  const mine: StateLockRecord = { ...record, pid: deps.pid, startedAt: deps.now().toISOString() };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, JSON.stringify(mine, null, 2), { flag: "wx" });
      return { acquired: true, file, record: mine, release: () => releaseStateLock(file, mine) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const existing = await readExisting(file);
    if (existing === null) continue;
    const { record: holder } = existing;
    const startedMs = holder ? Date.parse(holder.startedAt) : NaN;
    const ageMs =
      deps.now().getTime() - (Number.isFinite(startedMs) ? startedMs : existing.mtimeMs);
    const verdict = await judgeHolder({
      record: holder,
      selfPid: deps.pid,
      alive: holder ? deps.isAlive(holder.pid) : false,
      ageMs,
      probe: () => deps.probe(holder as StateLockRecord),
    });
    if (verdict.held) return { acquired: false, file, holder, reason: verdict.reason };
    const again = await readExisting(file);
    if (again !== null && again.text === existing.text) await unlink(file).catch(() => {});
  }
  const holder = (await readExisting(file))?.record ?? null;
  return { acquired: false, file, holder, reason: "another server took the lock first" };
}

/**
 * Removes the lock if it is still this process's. Synchronous so it can run
 * from a `process.on("exit")` handler, which covers every exit path at once.
 */
export function releaseStateLock(
  file: string,
  mine: Pick<StateLockRecord, "pid" | "startedAt">,
): void {
  try {
    const current = parseRecord(readFileSync(file, "utf8"));
    if (current?.pid === mine.pid && current.startedAt === mine.startedAt) unlinkSync(file);
  } catch {
    /* gone already, or unreadable: not ours to remove */
  }
}
