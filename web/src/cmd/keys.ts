/**
 * The global keyboard layer.
 *
 * Two rules shape this design:
 *
 * 1. **The cheatsheet cannot drift.** Bindings are data, and the `?` overlay
 *    renders the same array the listener dispatches from — so a shortcut that
 *    exists is documented, and a documented shortcut exists.
 * 2. **Typing always wins.** A dashboard has search boxes, revise notes and
 *    cron fields. A single-letter shortcut that fires while someone is typing
 *    "g" into a prompt is worse than no shortcut at all, so bindings are inert
 *    inside text inputs unless they explicitly opt in (Escape, ⌘K).
 *
 * Chords (`g` then `c`) follow the convention users already know from Gmail and
 * GitHub. The prefix window is short and self-cancelling, so a stray `g` never
 * leaves the app in a modal state.
 */

export interface Binding {
  /**
   * Either a single combo (`"mod+k"`, `"?"`, `"Escape"`) or a two-key chord
   * (`"g c"`). `mod` is ⌘ on Apple platforms and Ctrl elsewhere.
   */
  keys: string;
  /** What the shortcut does, in the imperative, for the cheatsheet. */
  label: string;
  /** Cheatsheet grouping. */
  group: string;
  run: () => void;
  /** Fire even while a text field has focus. Default false. */
  allowInInput?: boolean;
  /** Skip the binding entirely when this returns false (e.g. needs admin). */
  when?: () => boolean;
  /** Keep the binding working but hide it from the cheatsheet. */
  hidden?: boolean;
}

/** How long a chord prefix stays armed. Long enough to be deliberate, short
 *  enough that a stray press can't surprise you later. */
export const CHORD_WINDOW_MS = 1400;

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** True when the event target is somewhere the user is composing text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // `isContentEditable` is the right check in a browser but is unimplemented in
  // jsdom, so fall back to the attribute — and use `closest` so a keypress on a
  // child of an editable region counts too.
  if (target.isContentEditable || target.closest('[contenteditable="true"]') !== null) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  // Checkboxes, radios and buttons are not text entry, so a shortcut over one
  // is still welcome.
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "reset", "range", "file"].includes(type);
}

function isApple(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

/** Canonical form of the pressed key: `"mod+k"`, `"shift+?"` → `"?"`, `"g"`. */
export function normalizeEvent(e: KeyEventLike, platform: string): string | null {
  const key = e.key;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return null;
  const mod = isApple(platform) ? e.metaKey : e.ctrlKey;
  const parts: string[] = [];
  if (mod) parts.push("mod");
  if (e.altKey) parts.push("alt");
  // Shift is only meaningful for keys it does not already transform. `?` is
  // shift+/ on a US layout but arrives as `?`, so recording shift would make
  // the binding unwritable.
  if (e.shiftKey && key.length > 1) parts.push("shift");
  parts.push(key.length === 1 ? key.toLowerCase() : key);
  return parts.join("+");
}

export interface DispatchResult {
  /** The binding to run, if the press completed one. */
  binding: Binding | null;
  /** The chord prefix now armed (e.g. `"g"`), or null. */
  pending: string | null;
  /** Whether the press was consumed and the browser default should be stopped. */
  handled: boolean;
}

/**
 * Resolves one keypress against the bindings.
 *
 * Pure on purpose: chord state, the typing check and platform differences are
 * exactly the parts that are painful to test through a DOM, so they are
 * arguments instead of ambient state.
 */
export function dispatchKey(
  e: KeyEventLike,
  opts: {
    bindings: Binding[];
    pending: string | null;
    typing: boolean;
    platform: string;
  },
): DispatchResult {
  const { bindings, pending, typing, platform } = opts;
  const combo = normalizeEvent(e, platform);
  if (combo === null) return { binding: null, pending, handled: false };

  const active = bindings.filter((b) => b.when?.() !== false);
  const usable = active.filter((b) => !typing || b.allowInInput === true);

  // Mid-chord: only the second half of a chord can complete, and anything else
  // simply disarms — no fallthrough to a single-key binding, which would make
  // `g` then `x` fire the plain `x` shortcut.
  if (pending !== null) {
    const chord = usable.find((b) => b.keys === `${pending} ${combo}`);
    if (chord) return { binding: chord, pending: null, handled: true };
    return { binding: null, pending: null, handled: false };
  }

  const exact = usable.find((b) => b.keys === combo);
  if (exact) return { binding: exact, pending: null, handled: true };

  const startsChord = usable.some((b) => b.keys.startsWith(`${combo} `));
  if (startsChord) return { binding: null, pending: combo, handled: true };

  return { binding: null, pending: null, handled: false };
}

/** Renders a binding for display: `"mod+k"` → `"⌘K"` / `"Ctrl K"`. */
export function formatKeys(keys: string, platform: string): string[] {
  const apple = isApple(platform);
  return keys.split(" ").map((combo) =>
    combo
      .split("+")
      .map((part) => {
        if (part === "mod") return apple ? "⌘" : "Ctrl";
        if (part === "alt") return apple ? "⌥" : "Alt";
        if (part === "shift") return apple ? "⇧" : "Shift";
        if (part === "Escape") return "Esc";
        if (part === "ArrowUp") return "↑";
        if (part === "ArrowDown") return "↓";
        if (part === "Enter") return "↵";
        return part.length === 1 ? part.toUpperCase() : part;
      })
      .join(apple ? "" : " "),
  );
}
