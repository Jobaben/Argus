import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "./atomicWrite.js";
import { readJson } from "./readJson.js";
import { KeyedMutex } from "../mutex.js";

/**
 * Dedupe ledger for `after`-triggered chain fires.
 *
 * The scheduler tick walks every enabled pipeline/schedule with an `after`
 * trigger and looks for source instances it hasn't fired from yet. Without a
 * persisted record of "already fired", a restart mid-tick (or an instance
 * listing that got truncated by retention) could refire the same source
 * instance into the same target. The ledger is the guard: `{ [sourceInstanceId]:
 * targetId[] }`, one entry per source instance that has fired at least one
 * chain, capped to the most recent 500 source instances so the file can't grow
 * without bound on a long-lived install.
 */
export type ChainLedger = Record<string, string[]>;

const CAP = 500;
const lock = new KeyedMutex();
const LOCK_KEY = "chains";

export async function readChainLedger(): Promise<ChainLedger> {
  const raw = await readJson<unknown>(paths.chainsFile(), {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ChainLedger = {};
  for (const [sourceId, targets] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(targets)) out[sourceId] = targets.filter((t) => typeof t === "string");
  }
  return out;
}

/** True if `targetId` has already been fired from `sourceInstanceId`. */
export function alreadyChained(
  ledger: ChainLedger,
  sourceInstanceId: string,
  targetId: string,
): boolean {
  return ledger[sourceInstanceId]?.includes(targetId) ?? false;
}

/**
 * Records that `targetId` was just fired from `sourceInstanceId`, evicting the
 * oldest entries past the 500-instance cap (insertion order — plain objects
 * preserve it for string keys that aren't array indices, and every key here is
 * a UUID). Serialized under a single key: the tick processes chains one at a
 * time, but this guards against any future concurrent caller too.
 */
export async function recordChainFire(sourceInstanceId: string, targetId: string): Promise<void> {
  return lock.withLock(LOCK_KEY, async () => {
    const ledger = await readChainLedger();
    const existing = ledger[sourceInstanceId] ?? [];
    if (existing.includes(targetId)) return;
    ledger[sourceInstanceId] = [...existing, targetId];
    const keys = Object.keys(ledger);
    if (keys.length > CAP) {
      for (const dead of keys.slice(0, keys.length - CAP)) delete ledger[dead];
    }
    await atomicWriteJson(paths.chainsFile(), ledger);
  });
}
