import { useCallback, useEffect, useRef, useState } from "react";
import type { ToastItem } from "../ds/Toast";

const TOAST_TTL_MS = 8000;
const MAX_TOASTS = 4;

/**
 * The transient-toast queue every notification source shares: capped stack,
 * auto-dismiss after a TTL, timers cleaned on unmount. Sources (agent
 * transitions, monitor alerts) decide *what* to toast; this owns *how* toasts
 * live and die so the behavior stays identical across sources.
 */
export function useToastQueue(): {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, "id"> & { key: string }) => void;
  dismiss: (id: string) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seqRef = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    ({ key, ...toast }: Omit<ToastItem, "id"> & { key: string }) => {
      const id = `${key}:${seqRef.current++}`;
      setToasts((ts) => [...ts, { ...toast, id }].slice(-MAX_TOASTS));
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_TTL_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}
