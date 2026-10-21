import type { ReactNode } from "react";
import { Button, Icon } from "../ds";

/**
 * The foot of a Pipelines or a Scheduler card. One shape for both, because the
 * two pages are peers and a reader moves between them: they used to put Run now
 * in different places, at different sizes, over different separators, and
 * hold an error in different spots.
 *
 * Using the thing comes first and managing it last. The run controls lead —
 * Run now as the card's one secondary button, Stop as its one red outline —
 * then the ghost actions that open something (Analyze, Edit). Housekeeping is
 * held apart at the far end, as one group that wraps as one on a phone: Enable
 * or Disable, and a Delete that asks before it acts and so stays quiet until
 * reached for. A refused action is said on its own line under the buttons, on
 * the card it is about rather than at the top of a long page.
 */
export function CardFooter({
  children,
  manage,
  error,
}: {
  /** Run controls, then the actions that open something. */
  children: ReactNode;
  /** Enable or Disable, then Delete. */
  manage: ReactNode;
  error?: string | null;
}) {
  return (
    <footer className="mt-auto flex flex-wrap items-center gap-1.5 rounded-b-tile border-t border-line bg-ground-2/40 px-4 py-2.5 sm:px-5">
      {children}
      <div className="ml-auto flex items-center gap-1">{manage}</div>
      {error && (
        <p role="alert" className="flex basis-full items-start gap-1.5 text-caption text-fail-ink">
          <Icon name="alert" size={14} className="mt-px text-fail" />
          <span className="min-w-0 break-words">Couldn&apos;t complete that: {error}</span>
        </p>
      )}
    </footer>
  );
}

/**
 * A count that filters a list: the button language with a pressed state — a
 * quiet outlined ghost at rest, a lit secondary while its filter is on — so it
 * focuses and presses like every other control. A count's tone is carried by
 * what it says (the failing count's dot and words are red), not by a skin of
 * its own. Shared by the Scheduler and Pipelines, so the two peer pages
 * summarise themselves in one idiom.
 */
export function FilterChip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      aria-pressed={selected}
      onClick={onClick}
      className={selected ? "" : "border border-line"}
    >
      {children}
    </Button>
  );
}
