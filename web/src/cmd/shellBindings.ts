import { useMemo } from "react";
import type { Binding } from "./keys";
import type { Destination } from "./commands";

/**
 * The app's keyboard map, in one place.
 *
 * `g <key>` chords for navigation follow the convention users already have from
 * Gmail, GitHub and Linear, so the muscle memory transfers. Letters are chosen
 * to be mnemonic even where that costs consistency (`u` for bUdget, `h` for the
 * Chronicle's history) — a chord you can guess beats a chord that fits a
 * pattern you have to learn.
 */
export interface ShellActions {
  openPalette: () => void;
  openShortcuts: () => void;
  closeOverlays: () => void;
  /** True while any overlay is open, so Escape is only claimed when it means
   *  something — otherwise Escape must stay available to the page. */
  overlayOpen: () => boolean;
  navigate: (tabId: string) => void;
}

/** The `g <key>` chord per destination id, where one exists. */
export const NAV_CHORDS: Record<string, string> = {
  command: "c",
  briefing: "b",
  chronicle: "h",
  launch: "l",
  schedules: "s",
  monitors: "m",
  issues: "i",
  pipelines: "p",
  budget: "u",
  agents: "a",
};

export function useShellBindings(destinations: Destination[], actions: ShellActions): Binding[] {
  return useMemo(() => {
    const bindings: Binding[] = [
      {
        keys: "mod+k",
        label: "Open the command palette",
        group: "General",
        allowInInput: true,
        run: actions.openPalette,
      },
      {
        keys: "?",
        label: "Show keyboard shortcuts",
        group: "General",
        run: actions.openShortcuts,
      },
      {
        keys: "/",
        label: "Search transcripts",
        group: "General",
        run: () => actions.navigate("search"),
      },
      {
        keys: "Escape",
        label: "Close the palette or dialog",
        group: "General",
        allowInInput: true,
        when: actions.overlayOpen,
        run: actions.closeOverlays,
      },
    ];

    for (const dest of destinations) {
      const key = NAV_CHORDS[dest.id];
      if (!key) continue;
      bindings.push({
        keys: `g ${key}`,
        label: dest.label,
        group: "Go to",
        run: () => actions.navigate(dest.id),
      });
    }

    return bindings;
  }, [destinations, actions]);
}
