import type { IconName } from "../ds";
import type { AttentionItem, AttentionKind } from "../types";

/**
 * What each kind of attention item is called, where acting on it happens, and
 * what acting is called. The Briefing's cards and the Command Center's "Needs
 * you" rows both read it: they kept a copy each, and the copies drifted until
 * one page said "Schedule failing" for what the other called "Monitor failing".
 * The labels follow the Health page, where both kinds of monitor link, and
 * which calls their statuses "Down" and "Failing".
 *
 * The verb is on the item because one that only names a problem leaves the
 * reader to work out what to do about it; "Review gate" is the next step, said
 * once, where the eye already is.
 *
 * `rank` is the order items are read in. Something blocked on a person (a gate)
 * or silently not running (a monitor that is down) comes before something that
 * ran and went wrong: the first two get worse every minute nobody looks, the
 * rest will still be there.
 */
export const ATTENTION_KINDS: Record<
  AttentionKind,
  {
    label: string;
    tone: "fail" | "await";
    verb: string;
    icon: IconName;
    rank: number;
    /** Where the item goes when its id says nothing more specific. */
    href: string;
  }
> = {
  "gate-waiting": {
    label: "Needs approval",
    tone: "await",
    verb: "Review gate",
    icon: "approve",
    rank: 0,
    href: "#/command",
  },
  "monitor-down": {
    label: "Monitor down",
    tone: "fail",
    verb: "Open monitor",
    icon: "activity",
    rank: 0,
    href: "#/health",
  },
  "monitor-failing": {
    label: "Monitor failing",
    tone: "fail",
    verb: "Open monitor",
    icon: "x-circle",
    rank: 1,
    href: "#/health",
  },
  anomaly: {
    label: "Anomaly",
    tone: "await",
    verb: "Inspect run",
    icon: "bolt",
    rank: 2,
    href: "#/health/watchtower",
  },
  "issue-open": {
    label: "Open issue",
    tone: "fail",
    verb: "Triage issue",
    icon: "layers",
    rank: 3,
    href: "#/issues",
  },
};

/**
 * Where one item's link goes.
 *
 * A gate is acted on in the Command Center's review drawer and nowhere else —
 * the Pipelines page can only stop an instance — so it deep-links to the drawer
 * for *this* instance, the same link the palette and `argus tail` use. An
 * anomaly's id is `<key>|<metric>|<runId>` by contract, so it opens the run it
 * is about; the Watchtower list is the fallback for an id without that shape.
 */
export function attentionHref(item: Pick<AttentionItem, "kind" | "id">): string {
  if (item.kind === "gate-waiting") return `#/command/${encodeURIComponent(item.id)}`;
  if (item.kind === "anomaly") {
    const parts = item.id.split("|");
    const runId = parts.length >= 3 ? parts[parts.length - 1] : "";
    if (runId) return `#/run/${encodeURIComponent(runId)}`;
  }
  return ATTENTION_KINDS[item.kind].href;
}
