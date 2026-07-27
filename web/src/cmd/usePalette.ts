import { useCallback, useMemo, useState } from "react";
import { useLiveResource } from "../live/useLiveResource";
import type { PaletteEntry } from "../types";
import { buildCommands, type Command, type Destination } from "./commands";

/**
 * Loads the palette's search index and turns it into commands.
 *
 * The index is fetched only while the palette is open — `path: null` makes
 * {@link useLiveResource} inert — so the shell pays nothing for a feature most
 * page views never use. Because the hook keeps its last value across a null
 * path, reopening shows the previous index instantly and revalidates behind it
 * (and the ETag means an unchanged index is a 304).
 */
export function usePalette(
  open: boolean,
  ctx: {
    destinations: Destination[];
    canAdmin: boolean;
    approveGate: (instanceId: string) => Promise<unknown>;
    runSchedule: (scheduleId: string) => Promise<unknown>;
    markCaughtUp: () => Promise<unknown>;
    showShortcuts: () => void;
  },
): { commands: Command[]; loading: boolean; error: string | null } {
  const { data, loading, error } = useLiveResource<PaletteEntry[]>(open ? "/api/palette" : null, {
    events: ["pipelines:changed", "schedules:changed", "issues:changed", "agents:changed"],
    select: (j) => (j as { entries?: PaletteEntry[] }).entries ?? [],
    initial: [],
    // No polling: the palette is open for seconds at a time and the change
    // events cover anything that could move underneath it.
    pollMs: 0,
  });

  const commands = useMemo(
    () =>
      buildCommands({
        destinations: ctx.destinations,
        entries: data,
        canAdmin: ctx.canAdmin,
        actions: {
          approveGate: ctx.approveGate,
          runSchedule: ctx.runSchedule,
          markCaughtUp: ctx.markCaughtUp,
          showShortcuts: ctx.showShortcuts,
        },
      }),
    [data, ctx],
  );

  return { commands, loading, error };
}

/** Open/close state for the palette, kept out of the render-heavy shell. */
export function usePaletteState(): {
  open: boolean;
  toggle: () => void;
  show: () => void;
  hide: () => void;
} {
  const [open, setOpen] = useState(false);
  return {
    open,
    toggle: useCallback(() => setOpen((o) => !o), []),
    show: useCallback(() => setOpen(true), []),
    hide: useCallback(() => setOpen(false), []),
  };
}
