import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { highlight, rank } from "./fuzzy";
import { groupCommands, type Command } from "./commands";
import { pushRecent, readRecents, recencyBonus } from "./recents";
/**
 * Lazy: the palette itself must open instantly on ⌘K, and intent mode is only
 * reached once someone deliberately asks for it. Keeping it out of the initial
 * payload costs a fetch on first use and buys back the space for everyone who
 * only ever jumps and searches.
 */
const OmnibarIntent = lazy(() =>
  import("./OmnibarIntent").then((m) => ({ default: m.OmnibarIntent })),
);
import { looksLikeIntent } from "./intent";
import { SURFACE, usePresence, useSurfaceMotion } from "../ds";
import type { PaletteSeverity } from "../types";

const SEVERITY_TEXT: Record<PaletteSeverity, string> = {
  none: "text-ink-faint",
  info: "text-queue",
  warn: "text-await",
  error: "text-fail",
};

/**
 * The command palette.
 *
 * Implemented as the ARIA combobox-with-listbox pattern rather than a list of
 * buttons: focus never leaves the text field, so typing and choosing are the
 * same gesture, and `aria-activedescendant` tells a screen reader which row is
 * current without stealing focus. That is the whole reason this feels fast —
 * every other design makes you decide between typing and arrowing.
 *
 * Mounted only while open (see the `open` guard at the bottom of this file), so
 * "reset the query" is just React's own initial state rather than an effect
 * racing the first render.
 */
function Palette({
  onClose,
  commands,
  loading,
  visible,
  onExited,
}: {
  onClose: () => void;
  commands: Command[];
  /** True while the index is still loading; the list is usable regardless. */
  loading?: boolean;
  /** The caller's `open`. False starts the exit while this stays mounted. */
  visible: boolean;
  onExited: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** The sentence being compiled, once the user has asked for that. */
  const [intent, setIntent] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Captured at mount: whatever had focus before the palette opened gets it
  // back when the palette closes.
  const restoreFocus = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-opt-${index}`;
  // The palette rose in over 160ms and vanished in zero, and it is the surface
  // opened and closed most often in the app — so it was also the loudest place
  // the motion was half-finished. `rise` is the same keyframe pair, played
  // backwards and faster on the way out, and reversible mid-flight: ⌘K ⌘K ⌘K
  // now tracks the keystrokes instead of restarting from opacity zero.
  const scrimRef = useSurfaceMotion<HTMLDivElement>(visible, SURFACE.scrim);
  const dialogRef = useSurfaceMotion<HTMLDivElement>(visible, SURFACE.rise, onExited);

  useEffect(() => {
    // Focus after paint: the input mounts with this overlay.
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    const restore = restoreFocus.current;
    return () => {
      cancelAnimationFrame(raf);
      restore?.focus?.();
    };
  }, []);

  const ranked = useMemo(() => {
    const matches = rank(query, commands);
    if (query.trim().length > 0) return matches;
    // Empty query: float recents to the top. `sort` is stable, so everything
    // else keeps the curated order from buildCommands.
    return [...matches].sort(
      (a, b) => recencyBonus(b.item.id, recents) - recencyBonus(a.item.id, recents),
    );
  }, [query, commands, recents]);

  const groups = useMemo(() => groupCommands(ranked.map((r) => r.item)), [ranked]);
  // Arrow keys traverse the rendered order, which is grouped — so flatten the
  // groups rather than reusing the flat ranking.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const positionsById = useMemo(
    () => new Map(ranked.map((r) => [r.item.id, r.positions])),
    [ranked],
  );

  // Clamped during render rather than corrected in an effect: a narrower query
  // can shrink the list under the cursor, and an effect would paint one frame
  // with the highlight past the end.
  const activeIndex = flat.length === 0 ? 0 : Math.min(selected, flat.length - 1);

  const runCommand = useCallback(
    (command: Command) => {
      setRecents(pushRecent(command.id));
      if (command.href) {
        window.location.hash = command.href;
        onClose();
        return;
      }
      if (!command.run) {
        onClose();
        return;
      }
      const result = command.run();
      if (!(result instanceof Promise)) {
        onClose();
        return;
      }
      // An action that talks to the server keeps the palette open just long
      // enough to report a failure — closing on submit would swallow it.
      setPending(command.id);
      setFailure(null);
      void result
        .then(() => onClose())
        .catch((e: unknown) => {
          setFailure(e instanceof Error ? e.message : String(e));
          setPending(null);
        });
    },
    [onClose],
  );

  const move = useCallback(
    (delta: number) => {
      setSelected((i) => {
        if (flat.length === 0) return 0;
        // Wrap: a palette you can arrow off the end of feels broken.
        return (Math.min(i, flat.length - 1) + delta + flat.length) % flat.length;
      });
    },
    [flat.length],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setSelected(0);
        break;
      case "End":
        e.preventDefault();
        setSelected(Math.max(0, flat.length - 1));
        break;
      case "Enter": {
        e.preventDefault();
        // ⌘↵ asks Argus to interpret the sentence even when commands matched;
        // a bare ↵ only falls through to intent mode when nothing did, so the
        // fuzzy-jump the palette exists for is never hijacked.
        const asIntent = (e.metaKey || e.ctrlKey || flat.length === 0) && looksLikeIntent(query);
        if (asIntent) {
          setIntent(query.trim());
          break;
        }
        const command = flat[activeIndex];
        if (command && pending === null) runCommand(command);
        break;
      }
      // Escape is handled on the dialog, not here — see `onDialogKeyDown`.
      default:
        break;
    }
  };

  /**
   * Escape, wherever focus happens to be.
   *
   * In intent mode focus moves to the confirm button, so an Escape handler on
   * the input alone would silently stop working exactly when there is most to
   * lose. Handling it on the dialog catches both, and the first press only
   * leaves intent mode: dropping a typed sentence on a stray keypress is a real
   * cost, and the second press still closes.
   */
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (intent) setIntent(null);
    else onClose();
  };

  useEffect(() => {
    // Leaving intent mode unmounts whatever had focus inside it (the confirm
    // button), which would drop focus to the body and leave the palette's own
    // keys dead. Put the caret back where the user expects it.
    if (!intent) inputRef.current?.focus();
  }, [intent]);

  // Keep the highlighted row visible when arrowing through a long list.
  useEffect(() => {
    const el = listRef.current?.querySelector(`#${CSS.escape(optionId(activeIndex))}`);
    el?.scrollIntoView({ block: "nearest" });
    // optionId is derived from listboxId, which is stable for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, flat.length]);

  return (
    <div
      ref={scrimRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-ground/70 px-4 pt-[10vh] backdrop-blur-sm"
      inert={!visible}
      aria-hidden={visible ? undefined : true}
      // A click on the backdrop dismisses; a click inside must not bubble to it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onDialogKeyDown}
        className="flex w-full max-w-[640px] flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-[0_24px_80px_-12px_rgb(0_0_0/0.8)]"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <span aria-hidden="true" className="text-base text-ink-faint">
            ⌕
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={!intent}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={!intent && flat.length > 0 ? optionId(activeIndex) : undefined}
            aria-label="Search commands, pipelines, schedules and transcripts"
            placeholder="Jump to or run anything…"
            autoComplete="off"
            spellCheck={false}
            // The dialog surface and the caret both signal focus, and this input is
            // auto-focused as the palette's only field — so the global focus ring
            // would only add noise around the whole search row.
            className="min-w-0 flex-1 bg-transparent py-3.5 text-[15px] text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
          />
          {loading && (
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              indexing…
            </span>
          )}
        </div>

        {intent ? (
          <Suspense
            fallback={
              <p className="px-4 py-8 text-center text-sm text-ink-faint" role="status">
                Working out what that means…
              </p>
            }
          >
            <OmnibarIntent intent={intent} onClose={onClose} />
          </Suspense>
        ) : (
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Results"
            className="max-h-[52vh] overflow-y-auto py-1.5"
          >
            {flat.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-ink-faint">
                <p>Nothing matches “{query}”.</p>
                {looksLikeIntent(query) && (
                  <p className="mx-auto mt-2 max-w-sm text-xs">
                    That reads like an instruction — press <kbd className="text-ink-dim">↵</kbd> and
                    Argus will show you exactly what it would change before changing anything.
                  </p>
                )}
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.group} role="group" aria-labelledby={`${listboxId}-${group.group}`}>
                  <div
                    id={`${listboxId}-${group.group}`}
                    className="px-4 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint"
                  >
                    {group.group}
                  </div>
                  {group.items.map((command) => {
                    const index = flat.indexOf(command);
                    const active = index === activeIndex;
                    return (
                      <div
                        key={command.id}
                        id={optionId(index)}
                        role="option"
                        aria-selected={active}
                        // The input keeps focus, so rows are pointer targets only.
                        onMouseMove={() => setSelected(index)}
                        onMouseDown={(e) => {
                          e.preventDefault(); // don't steal focus from the input
                          if (pending === null) runCommand(command);
                        }}
                        // A pressed state on the row, not just a hover tint: the
                        // palette is the app's fastest surface and it is the one
                        // place a click had no physical answer at all.
                        className={`flex cursor-pointer items-center gap-3 px-4 py-2 transition-transform duration-(--duration-press) motion-safe:active:scale-[0.99] ${
                          active ? "bg-surface-2" : ""
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`w-4 shrink-0 text-center text-[12px] ${
                            SEVERITY_TEXT[command.severity ?? "none"]
                          }`}
                        >
                          {command.icon ?? "·"}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] leading-tight text-ink">
                            {highlight(command.title, positionsById.get(command.id) ?? []).map(
                              (segment, i) => (
                                <span
                                  key={i}
                                  className={segment.match ? "font-bold text-eye" : undefined}
                                >
                                  {segment.text}
                                </span>
                              ),
                            )}
                          </span>
                          {command.subtitle && (
                            <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">
                              {command.subtitle}
                            </span>
                          )}
                        </span>
                        {pending === command.id ? (
                          <span
                            role="status"
                            className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-run"
                          >
                            working…
                          </span>
                        ) : (
                          command.badge && (
                            <span
                              className={`shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-[10px] ${
                                SEVERITY_TEXT[command.severity ?? "none"]
                              }`}
                            >
                              {command.badge}
                            </span>
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        )}

        {failure && (
          <p
            role="alert"
            className="border-t border-fail/30 bg-fail/10 px-4 py-2 text-xs text-fail"
          >
            {failure}
          </p>
        )}

        <div className="flex items-center gap-4 border-t border-line px-4 py-2 font-mono text-[10px] text-ink-faint">
          <span>
            <kbd className="text-ink-dim">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="text-ink-dim">↵</kbd> run
          </span>
          <span>
            <kbd className="text-ink-dim">esc</kbd> {intent ? "back" : "close"}
          </span>
          {looksLikeIntent(query) && !intent && (
            <span>
              <kbd className="text-ink-dim">⌘↵</kbd> interpret
            </span>
          )}
          <span className="ml-auto">
            {flat.length} of {commands.length}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Mount guard. Keeping the open/closed decision here — rather than an early
 * return inside {@link Palette} — means the palette's state *is* fresh every
 * time it opens, with no reset effect to get wrong.
 *
 * `usePresence` widens "open" to "open, or still leaving": the difference between
 * the two is the exit, and the palette used to have none.
 */
export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  loading?: boolean;
}) {
  const { open, ...rest } = props;
  const { present, exited } = usePresence(open);
  if (!present) return null;
  return <Palette {...rest} visible={open} onExited={exited} />;
}
