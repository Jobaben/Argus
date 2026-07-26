/**
 * Recently-run commands, persisted per browser.
 *
 * A palette that always opens on the same alphabetical list makes you read it
 * every time. Remembering the last handful of things you ran turns the common
 * case into ⌘K–Enter.
 *
 * Recency only reorders the *empty* query. Once the user types, ranking is
 * purely about what they typed — a palette that quietly prefers history over
 * relevance is a palette you stop trusting.
 */

const KEY = "argus.palette.recents";
const MAX = 8;

function read(storage: Storage | undefined): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return []; // private mode, quota, or someone else's key — recents are optional
  }
}

function storageOrNull(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readRecents(storage: Storage | undefined = storageOrNull()): string[] {
  return read(storage).slice(0, MAX);
}

/** Moves `id` to the front, de-duplicated, capped. Returns the new list. */
export function pushRecent(id: string, storage: Storage | undefined = storageOrNull()): string[] {
  const next = [id, ...read(storage).filter((v) => v !== id)].slice(0, MAX);
  try {
    storage?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* persistence is best-effort */
  }
  return next;
}

/**
 * Score bonus for a command, by how recently it was used. Only meaningful for
 * an empty query — see the note above.
 */
export function recencyBonus(id: string, recents: string[]): number {
  const index = recents.indexOf(id);
  return index === -1 ? 0 : MAX - index;
}
