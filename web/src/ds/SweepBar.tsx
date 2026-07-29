import { DURATION, useSyncedDelay } from "./motion";

/**
 * The indeterminate "working" strip.
 *
 * One component rather than the two copies it was, for two reasons that both
 * turned out to be motion reasons. The keyframe animates a transform now, not
 * `left`, which requires the element to actually be positioned at `left-0` — a
 * detail neither copy would have kept in step. And the phase comes from the
 * shared ambient clock, so a board with six working steps shows one rhythm
 * instead of six: several strips sweeping independently reads as clutter, in
 * phase it reads as one system with a pulse.
 */
export function SweepBar() {
  const beat = useSyncedDelay(DURATION.sweep);
  return (
    <div className="relative h-[5px] overflow-hidden rounded-full bg-ink-faint/15">
      <i
        style={{ animationDelay: beat }}
        className="absolute inset-y-0 left-0 w-2/5 animate-[sweep_var(--duration-sweep)_ease-in-out_infinite] rounded-full bg-gradient-to-r from-transparent via-run to-transparent"
      />
    </div>
  );
}
