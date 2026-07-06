import { useSyncExternalStore } from "react";

/** Decoded path segments of the current location hash: `#/sessions/a/b` →
 *  `["sessions", "a", "b"]`. Empty array at the root. */
export function hashSegments(): string[] {
  return window.location.hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

// Cache the array so getSnapshot is referentially stable between hashchanges
// (useSyncExternalStore requires a stable snapshot or it loops).
let cache: string[] = hashSegments();
let cacheKey = window.location.hash;
function getSnapshot(): string[] {
  if (window.location.hash !== cacheKey) {
    cacheKey = window.location.hash;
    cache = hashSegments();
  }
  return cache;
}

/** Reactive hash-route segments. Re-renders on navigation, so view state
 *  (which session, which sub-tab) lives in the URL — deep-linkable, reload-safe,
 *  and back-button friendly. */
export function useHashRoute(): string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
