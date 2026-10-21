/**
 * A failed load, in words that say what happened.
 *
 * Two different failures used to read the same. A request that never got an
 * answer (offline, the server down, the connection refused) and a request the
 * server answered with an error both came out as "Couldn't reach the Argus
 * server: …", and the second dropped the server's own reason for a bare
 * "HTTP 500". Someone reading "database is locked" knows where to look;
 * someone told the server is unreachable while it plainly answers does not.
 */

/** What a load says when no answer came back at all. The browser's own words
 *  for it ("Failed to fetch", "Load failed") tell an operator nothing more. */
export const UNREACHABLE = "Couldn't reach the Argus server";

/** An `Error` that knows the HTTP status it came from: null when the request
 *  got no answer, so a view can branch on the answer (a 404 is "no such run",
 *  not a failed load) without parsing the words. */
export type LoadFailure = Error & { status: number | null };

function failure(message: string, status: number | null): LoadFailure {
  return Object.assign(new Error(message), { status });
}

/** The server's reason for an error answer: its JSON `{error}` (or `{message}`)
 *  when it sent one, else the bare status — a proxy's HTML page has none. */
async function reasonFor(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown } | null;
    const said = body?.error ?? body?.message;
    if (typeof said === "string" && said.trim()) return said;
  } catch {
    // Not JSON: the status is all there is to say.
  }
  return `HTTP ${res.status}`;
}

/**
 * `fetch` for a load. Resolves with the response when the server answered
 * with something usable — a 2xx, or the 304 a caller asked for by sending a
 * validator — and otherwise rejects with a {@link LoadFailure} worded as
 * above. An abort rejects as itself: it is the caller's own doing, not a
 * failure to report.
 */
export async function fetchLoad(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (init?.signal?.aborted) throw e;
    throw failure(UNREACHABLE, null);
  }
  if (!res.ok && res.status !== 304) throw failure(await reasonFor(res), res.status);
  return res;
}

/** The HTTP status a caught load error came from, or null (no answer, or not
 *  a {@link LoadFailure} at all — a body that would not parse). */
export function statusOf(e: unknown): number | null {
  return (e as Partial<LoadFailure> | null)?.status ?? null;
}

/** A load error as one sentence: "Couldn't load the briefing: database is
 *  locked" when the server answered, and just "Couldn't reach the Argus
 *  server" when it did not — that is then the whole story. `verb` is for a
 *  load that is better called something else ("search", "refresh"). */
export function loadError(what: string, error: string, verb = "load"): string {
  return error === UNREACHABLE ? error : `Couldn't ${verb} ${what}: ${error}`;
}
