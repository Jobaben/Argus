import type { IconName } from "../ds/Icon";
import type { PaletteEntry, PaletteKind, PaletteSeverity } from "../types";
import type { Rankable } from "./fuzzy";

/**
 * What the palette can do, as data.
 *
 * A command is either a **jump** (change the hash) or a **do** (call the
 * server, then usually jump). Keeping both in one list is the point: the user
 * types "release" and gets *both* the board and the pending approval on it,
 * ranked together, without deciding up front whether they wanted to navigate or
 * to act.
 */

export type CommandGroup = "Go to" | "Actions" | "Pipelines" | "Schedules" | "Attention" | "Recent";

export interface Command extends Rankable {
  /** Stable across renders and rebuilds — used for recents and for React keys. */
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  group: CommandGroup;
  /** Short trailing label: a status word, or the shortcut that also does this. */
  badge?: string;
  severity?: PaletteSeverity;
  /** Where this goes, for a plain jump. */
  href?: string;
  /** What this does. Returning a promise lets the palette show a pending state. */
  run?: () => void | Promise<unknown>;
  /** Rendered as a leading glyph; keeps kinds distinguishable at a glance. */
  icon?: IconName;
}

/** One nav destination, as the shell knows it. */
export interface Destination {
  id: string;
  label: string;
  /** The `g <key>` chord that also reaches it, for the trailing hint. */
  chord?: string;
}

const KIND_ICON: Record<PaletteKind, IconName> = {
  pipeline: "pipeline",
  schedule: "clock",
  monitor: "activity",
  issue: "alert",
  agent: "bolt",
  project: "folder",
  session: "terminal",
};

const KIND_GROUP: Record<PaletteKind, CommandGroup> = {
  pipeline: "Pipelines",
  schedule: "Schedules",
  monitor: "Attention",
  issue: "Attention",
  agent: "Recent",
  project: "Recent",
  session: "Recent",
};

/**
 * Kinds whose subtitle is machine text — an agent's working directory or
 * command line, a session's project path — and is printed exactly as it came.
 * Every other subtitle is a phrase the index wrote ("every 2h", "3 sessions")
 * and reads as one.
 */
const MACHINE_SUBTITLE = new Set<PaletteKind>(["agent", "session"]);

/** The status words the index sends, in the words the rest of the app uses:
 *  a waiting gate is "Needs approval" on every StatusPill, so here too. */
const BADGE_WORDS: Record<string, string> = {
  await: "Needs approval",
  awaiting: "Needs approval",
  "awaiting-approval": "Needs approval",
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * An entry's badge as a person reads it: "Needs approval", "Running",
 * "Paused". The index speaks in status values ("needs approval", "down"), and
 * the palette was the one place they were printed as sent, lower case beside
 * rows whose every other label is sentence case. A shouted value is lowered
 * before it is capitalised, so "FAILED" reads "Failed" too.
 */
function statusBadge(badge: string | null): string | undefined {
  if (!badge) return undefined;
  const word = badge.toLowerCase();
  return BADGE_WORDS[word] ?? capitalise(badge === badge.toUpperCase() ? word : badge);
}

export interface CommandContext {
  destinations: Destination[];
  entries: PaletteEntry[];
  /** Whether privileged actions (approve, start) are available. */
  canAdmin: boolean;
  actions: {
    runSchedule: (scheduleId: string) => Promise<unknown>;
    markCaughtUp: () => Promise<unknown>;
    showShortcuts: () => void;
  };
}

/**
 * Builds the full command list, in the order an empty query should show it.
 *
 * Navigation comes first because it is the highest-frequency use and the one
 * with muscle memory; then the actions that need a human right now; then the
 * entity long tail. Ranking reorders everything as soon as a query exists, so
 * this ordering only governs the "just opened it" state.
 */
export function buildCommands(ctx: CommandContext): Command[] {
  const commands: Command[] = [];

  for (const dest of ctx.destinations) {
    commands.push({
      id: `go:${dest.id}`,
      title: dest.label,
      group: "Go to",
      icon: "arrow-right",
      badge: dest.chord,
      keywords: ["go", "open", "tab", dest.id],
      href: `#/${dest.id}`,
    });
  }

  // Gates first among the actions: a pipeline paused on a human is the most
  // time-sensitive thing Argus can tell you about. The palette *takes you to*
  // the review drawer — it never approves blind, because what is being
  // approved is what the drawer shows. Offered to everyone: looking is open.
  for (const entry of ctx.entries) {
    if (!entry.gateInstanceId) continue;
    commands.push({
      id: `review:${entry.gateInstanceId}`,
      title: `Review gate — ${entry.title}`,
      subtitle: "See what the paused phase produced, then approve or revise",
      group: "Actions",
      icon: "approve",
      severity: "warn",
      keywords: ["approve", "revise", "review", "gate", "resume", "unblock", entry.id],
      href: `#/command/${encodeURIComponent(entry.gateInstanceId)}`,
    });
  }

  for (const entry of ctx.entries) {
    if (!entry.runnableScheduleId) continue;
    const scheduleId = entry.runnableScheduleId;
    commands.push({
      id: `run:${scheduleId}`,
      title: `Run now — ${entry.title}`,
      subtitle: "Fire this schedule immediately",
      group: "Actions",
      icon: "play",
      keywords: ["run", "fire", "trigger", "now", entry.id],
      run: () => ctx.actions.runSchedule(scheduleId),
    });
  }

  commands.push({
    id: "action:caught-up",
    title: "Mark caught up",
    subtitle: "Reset the briefing window to now",
    group: "Actions",
    icon: "check",
    keywords: ["briefing", "ack", "acknowledge", "clear", "digest"],
    run: () => ctx.actions.markCaughtUp(),
  });

  commands.push({
    id: "action:shortcuts",
    title: "Keyboard shortcuts",
    subtitle: "Every shortcut in the app",
    group: "Actions",
    icon: "keyboard",
    badge: "?",
    keywords: ["help", "keys", "bindings", "cheatsheet"],
    run: () => ctx.actions.showShortcuts(),
  });

  for (const entry of ctx.entries) {
    commands.push({
      id: `entry:${entry.kind}:${entry.id}`,
      title: entry.title,
      subtitle:
        entry.subtitle && !MACHINE_SUBTITLE.has(entry.kind)
          ? capitalise(entry.subtitle)
          : (entry.subtitle ?? undefined),
      group: KIND_GROUP[entry.kind],
      icon: KIND_ICON[entry.kind],
      badge: statusBadge(entry.badge),
      severity: entry.severity,
      keywords: entry.keywords,
      href: entry.href,
    });
  }

  return commands;
}

/** The group order the palette renders in, regardless of match order within. */
export const GROUP_ORDER: CommandGroup[] = [
  "Actions",
  "Go to",
  "Attention",
  "Pipelines",
  "Schedules",
  "Recent",
];

/**
 * Groups ranked commands for display while preserving rank *within* each group,
 * and keeps the best-ranked command overall as the first row of the first
 * group — so Enter on an untouched query always does the top-ranked thing,
 * not whatever happens to sit in the first group.
 */
export function groupCommands<T extends { group: CommandGroup }>(
  ranked: T[],
): { group: CommandGroup; items: T[] }[] {
  if (ranked.length === 0) return [];
  const byGroup = new Map<CommandGroup, T[]>();
  for (const item of ranked) {
    const list = byGroup.get(item.group);
    if (list) list.push(item);
    else byGroup.set(item.group, [item]);
  }
  const topGroup = ranked[0].group;
  const order = [topGroup, ...GROUP_ORDER.filter((g) => g !== topGroup)];
  return order
    .filter((g) => byGroup.has(g))
    .map((group) => ({ group, items: byGroup.get(group) as T[] }));
}
