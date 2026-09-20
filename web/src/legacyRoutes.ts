/**
 * Routes that used to be destinations and now live inside another one.
 *
 * The nav was rebuilt around eight tabs: Launch became the Scheduler's
 * **One-off** sub-tab, Monitors and Watchtower became the two halves of
 * **Health**, and Projects, Activity and Tasks folded into Sessions or went
 * away. Their hashes are still in bookmarks, in the Vault's archived alert
 * links, in webhook payloads and in older `argus tail` output — so each one
 * is rewritten to where its content went rather than falling through to the
 * Command Center as an unknown hash would.
 *
 * Keys are the first hash segment; values are the full replacement path. Any
 * trailing segments are dropped: the sub-views these routes had (none) do not
 * map onto anything.
 */
const LEGACY_ROUTES: Record<string, string> = {
  launch: "schedules/oneoff",
  monitors: "health",
  watchtower: "health/watchtower",
  projects: "sessions",
  activity: "sessions",
  tasks: "command",
};

/** The canonical hash for `hash`, or null when it is already canonical. */
export function legacyRedirect(hash: string): string | null {
  const head = hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  const target = LEGACY_ROUTES[head];
  return target ? `#/${target}` : null;
}

/**
 * Rewrites the current location if it is a legacy route. Returns true when it
 * did — the caller should then wait for the `hashchange` the rewrite fires
 * rather than rendering the old route for one frame. `replace` rather than
 * assign, so the dead hash does not stay in history to be stepped back onto.
 */
export function applyLegacyRedirect(): boolean {
  const next = legacyRedirect(window.location.hash);
  if (next === null) return false;
  window.location.replace(next);
  return true;
}
