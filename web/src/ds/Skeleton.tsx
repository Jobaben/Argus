import type { ReactNode } from "react";
import { SURFACE, usePresence, useSurfaceMotion } from "./presence";
import { DURATION, useSyncedDelay } from "./motion";

/**
 * Loading placeholders.
 *
 * "Loading pipelines…" is honest but it throws away the one thing the client
 * already knows: the *shape* of what is coming. A skeleton that matches that
 * shape means the layout is settled before the data lands, so nothing jumps when
 * it does — and the wait reads as the page assembling rather than the page
 * being empty.
 *
 * The visual placeholders are `aria-hidden`, and {@link Loading} pairs them with
 * a live-region announcement, so swapping text for shapes does not cost a
 * screen-reader user the message they used to get.
 */

/** One shimmering block. Sizes come from the caller so each skeleton can match
 *  the element it is standing in for. */
export function Skeleton({ className = "" }: { className?: string }) {
  // In phase with every other shimmer on the page. A grid of twelve placeholders
  // each starting its sweep whenever it happened to mount looks like static; one
  // wave crossing all of them looks like a page assembling.
  const beat = useSyncedDelay(DURATION.shimmer);
  return (
    <div
      aria-hidden="true"
      style={{ animationDelay: beat }}
      className={`skeleton rounded ${className}`}
    />
  );
}

/**
 * A loading region: the visual skeleton plus the announcement it replaces.
 *
 * `aria-busy` lets assistive tech treat the region as in-flight rather than as
 * genuinely empty content, and the polite live region names what is loading.
 */
export function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading {label}…</span>
      {children}
    </div>
  );
}

/**
 * The skeleton-to-content handoff, as one continuous surface.
 *
 * The swap used to be hard: shimmer, blink, content. That blink is a small
 * betrayal of the skeleton's whole promise — the placeholder is there to say
 * "this is the shape of what is coming", and then the arrival contradicts it by
 * discarding the shape and starting over. Fading the skeleton out *over* the
 * content as the content fades in means the region never goes blank and never
 * flashes: one surface resolving, which is what was being claimed all along.
 *
 * The skeleton is in flow while loading (so the region has the right height from
 * the start) and absolutely positioned once it is only leaving (so the content
 * takes over the layout immediately, and the fade cannot push anything around).
 * It is `aria-hidden` and `inert` for that last 126ms: the announcement belongs
 * to the load, and the load is over.
 */
export function Handoff({
  busy,
  label,
  skeleton,
  children,
}: {
  busy: boolean;
  /** What is loading, for the live-region announcement. */
  label: string;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  const { present, exited } = usePresence(busy);
  const skeletonRef = useSurfaceMotion<HTMLDivElement>(busy, SURFACE.scrim, exited);
  return (
    <div className="relative">
      {present && (
        <div
          ref={skeletonRef}
          aria-hidden={busy ? undefined : true}
          inert={!busy}
          className={busy ? undefined : "pointer-events-none absolute inset-x-0 top-0"}
        >
          <Loading label={label}>{skeleton}</Loading>
        </div>
      )}
      {!busy && (
        <div className="motion-safe:animate-[fade-in_var(--duration-base)_ease-out]">
          {children}
        </div>
      )}
    </div>
  );
}

/** Stand-in for a paragraph or a stack of label/value lines. */
export function SkeletonText({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  // Varying the last line's width is the difference between "loading" and
  // "broken table of grey bars".
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={`h-3 ${i === lines - 1 ? "w-2/5" : i % 2 === 0 ? "w-full" : "w-4/5"}`}
        />
      ))}
    </div>
  );
}

/** Stand-in for one `Card`/`AgentTile`-shaped block. */
export function SkeletonTile({
  lines = 2,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`rounded-tile border border-line bg-surface px-4 py-3.5 ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-4 w-14 rounded-full" />
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className={`h-2.5 ${i === 0 ? "w-4/5" : "w-1/2"}`} />
        ))}
      </div>
    </div>
  );
}

/** A grid of tiles, in the same column layout the real content uses. */
export function SkeletonGrid({
  count = 4,
  columns = 2,
  lines = 2,
}: {
  count?: number;
  columns?: 1 | 2 | 3;
  lines?: number;
}) {
  const cols = {
    1: "grid-cols-1",
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-3",
  };
  return (
    <div className={`grid gap-4 ${cols[columns]}`}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonTile key={i} lines={lines} />
      ))}
    </div>
  );
}

/** A stack of list rows — schedules, runs, issues, occurrences. */
export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="flex items-center gap-3 rounded-tile border border-line bg-surface px-4 py-3"
        >
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-2.5 w-1/3" />
          <Skeleton className="ml-auto h-4 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** A row of the counter tiles most views open with. */
export function SkeletonCounters({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="rounded-tile border border-line bg-ground-2 px-5 py-3.5"
        >
          <Skeleton className="mx-auto h-8 w-12" />
          <Skeleton className="mx-auto mt-2 h-2 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * A pipeline board card: the phase header row, its rule, and one row of step
 * tiles. Matching the real grid matters more here than anywhere else — this is
 * the widest, tallest thing in the app, so a mismatched placeholder produces
 * the most jarring reflow.
 */
export function SkeletonBoardCard({ phases = 4 }: { phases?: number }) {
  return (
    <article
      aria-hidden="true"
      className="rounded-tile border border-line bg-gradient-to-b from-surface-2 to-surface px-4 py-3.5"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="ml-auto h-3 w-12" />
      </div>
      <div
        className="mt-3.5 grid gap-x-3.5 gap-y-2.5"
        style={{ gridTemplateColumns: `repeat(${phases}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: phases }, (_, i) => (
          <Skeleton key={`h${i}`} className="h-2.5 w-3/4" />
        ))}
        {Array.from({ length: phases }, (_, i) => (
          <div key={`r${i}`} className="h-[2px] rounded-full bg-line" />
        ))}
        {Array.from({ length: phases }, (_, i) => (
          <div
            key={`t${i}`}
            className="flex flex-col gap-2 rounded-tile border border-line bg-surface px-3.5 py-3"
          >
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-2 w-2/5" />
            <Skeleton className="h-2 w-3/5" />
          </div>
        ))}
      </div>
    </article>
  );
}
