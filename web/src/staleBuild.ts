/**
 * Recovering from a rebuild under an open tab.
 *
 * Views are lazy chunks with content-hashed names. Rebuild the UI while a tab
 * is open (a `git pull` and `npm run build` away) and that tab's main bundle
 * still names the *old* hashes; the server has already dropped them, so the
 * next navigation fails with "Failed to fetch dynamically imported module".
 * `React.lazy` caches that rejection, so "Try again" re-throws the same error
 * and the view stays broken until someone thinks to reload.
 *
 * A reload is the whole fix (the server re-reads `index.html`, see
 * `server/src/static.ts`), so do it for them: once, because if the chunk is
 * still missing after a fresh `index.html` then a reload loop would hide the
 * real problem behind a flickering page.
 */

const RELOADED_AT = "argus:stale-build-reload";
/** A second failure inside this window means the reload didn't fix it. */
const LOOP_WINDOW_MS = 10_000;

/** True for the errors browsers throw when a lazy chunk can't be fetched. */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    error.message,
  );
}

/**
 * Reload the page to pick up the current build, unless we just did. Returns
 * whether a reload was started.
 */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT));
    if (last && Date.now() - last < LOOP_WINDOW_MS) return false;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    // No storage (private mode, blocked site data): reloading without the loop
    // guard is worse than showing the error, so let the boundary handle it.
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * Vite fires `vite:preloadError` when a dynamic import or its preloads fail.
 * Reloading there catches the failure before any boundary renders it.
 */
export function installStaleBuildRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewBuild()) event.preventDefault();
  });
}
