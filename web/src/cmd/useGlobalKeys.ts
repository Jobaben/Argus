import { useEffect, useRef, useState } from "react";
import { CHORD_WINDOW_MS, dispatchKey, isTypingTarget, type Binding } from "./keys";

/**
 * Installs one `keydown` listener for the whole app and dispatches it through
 * the pure {@link dispatchKey}.
 *
 * One listener, not one per component: a shortcut layer assembled from a dozen
 * independent `useEffect`s is where double-fires and stale closures live. The
 * bindings array is read through a ref so re-renders never re-attach the
 * listener, and a binding closing over fresh state still sees it.
 *
 * Returns the armed chord prefix so the UI can show that `g` is waiting for a
 * second key — a chord you can't see is a chord you don't trust.
 */
export function useGlobalKeys(bindings: Binding[]): { pending: string | null } {
  const [pending, setPending] = useState<string | null>(null);
  const bindingsRef = useRef(bindings);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    bindingsRef.current = bindings;
  });

  useEffect(() => {
    const clearChord = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
      setPending(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // A key pressed as part of an IME composition is not a shortcut.
      if (e.isComposing) return;
      const result = dispatchKey(e, {
        bindings: bindingsRef.current,
        pending: pendingRef.current,
        typing: isTypingTarget(e.target),
        platform: navigator.platform || navigator.userAgent,
      });

      if (result.pending !== pendingRef.current) {
        clearChord();
        if (result.pending !== null) {
          pendingRef.current = result.pending;
          setPending(result.pending);
          timerRef.current = setTimeout(clearChord, CHORD_WINDOW_MS);
        }
      }
      if (result.handled) {
        e.preventDefault();
        e.stopPropagation();
      }
      result.binding?.run();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { pending };
}
