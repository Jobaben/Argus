import { describe, it, expect, vi } from "vitest";
import {
  dispatchKey,
  formatKeys,
  isTypingTarget,
  normalizeEvent,
  type Binding,
  type KeyEventLike,
} from "./keys";

const MAC = "MacIntel";
const WIN = "Win32";

function press(key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

function bind(keys: string, over: Partial<Binding> = {}): Binding {
  return { keys, label: keys, group: "Test", run: vi.fn(), ...over };
}

describe("normalizeEvent", () => {
  it("maps mod to ⌘ on Apple platforms and Ctrl elsewhere", () => {
    expect(normalizeEvent(press("k", { metaKey: true }), MAC)).toBe("mod+k");
    expect(normalizeEvent(press("k", { ctrlKey: true }), MAC)).toBe("k");
    expect(normalizeEvent(press("k", { ctrlKey: true }), WIN)).toBe("mod+k");
    expect(normalizeEvent(press("k", { metaKey: true }), WIN)).toBe("k");
  });

  it("lowercases single characters so caps lock does not break shortcuts", () => {
    expect(normalizeEvent(press("G"), WIN)).toBe("g");
  });

  it("does not record shift for a key shift already transformed", () => {
    // `?` arrives as `?` with shiftKey set; recording shift would make the
    // binding "shift+?" and therefore unwritable.
    expect(normalizeEvent(press("?", { shiftKey: true }), WIN)).toBe("?");
  });

  it("records shift for named keys where it is meaningful", () => {
    expect(normalizeEvent(press("Enter", { shiftKey: true }), WIN)).toBe("shift+Enter");
  });

  it("ignores bare modifier presses", () => {
    for (const k of ["Shift", "Control", "Alt", "Meta"]) {
      expect(normalizeEvent(press(k), WIN)).toBeNull();
    }
  });
});

describe("dispatchKey", () => {
  const bindings = [
    bind("mod+k", { allowInInput: true }),
    bind("?"),
    bind("g c"),
    bind("g b"),
    bind("c"),
    bind("Escape", { allowInInput: true }),
  ];
  const base = { bindings, pending: null, typing: false, platform: WIN };

  it("runs a single-key binding", () => {
    const r = dispatchKey(press("?", { shiftKey: true }), base);
    expect(r.binding?.keys).toBe("?");
    expect(r.handled).toBe(true);
  });

  it("arms a chord prefix without running anything", () => {
    const r = dispatchKey(press("g"), base);
    expect(r.binding).toBeNull();
    expect(r.pending).toBe("g");
    expect(r.handled).toBe(true); // swallow it, or the page scrolls
  });

  it("completes a chord on the second key", () => {
    const r = dispatchKey(press("c"), { ...base, pending: "g" });
    expect(r.binding?.keys).toBe("g c");
    expect(r.pending).toBeNull();
  });

  it("disarms on an unknown second key instead of firing the single-key binding", () => {
    // The dangerous case: `g` then `x` must not fall through to a plain `x`,
    // and `g` then `c` must not *also* fire the standalone `c`.
    const r = dispatchKey(press("x"), { ...base, pending: "g" });
    expect(r.binding).toBeNull();
    expect(r.pending).toBeNull();
    expect(r.handled).toBe(false);
  });

  it("returns unhandled for a key nothing claims", () => {
    const r = dispatchKey(press("q"), base);
    expect(r.handled).toBe(false);
    expect(r.binding).toBeNull();
  });

  describe("while typing", () => {
    const typing = { ...base, typing: true };

    it("suppresses single-letter and chord bindings", () => {
      expect(dispatchKey(press("c"), typing).binding).toBeNull();
      expect(dispatchKey(press("g"), typing).pending).toBeNull();
      expect(dispatchKey(press("?", { shiftKey: true }), typing).binding).toBeNull();
    });

    it("still fires bindings that opted in", () => {
      expect(dispatchKey(press("k", { ctrlKey: true }), typing).binding?.keys).toBe("mod+k");
      expect(dispatchKey(press("Escape"), typing).binding?.keys).toBe("Escape");
    });
  });

  it("skips a binding whose `when` guard is false", () => {
    const guarded = [
      bind("r", { when: () => false }),
      bind("r", { when: () => true, label: "on" }),
    ];
    const r = dispatchKey(press("r"), { ...base, bindings: guarded });
    expect(r.binding?.label).toBe("on");
  });

  it("treats an absent `when` as enabled", () => {
    const r = dispatchKey(press("c"), base);
    expect(r.binding?.keys).toBe("c");
  });
});

describe("isTypingTarget", () => {
  function el(html: string): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild as HTMLElement;
  }

  it("is true for text entry", () => {
    expect(isTypingTarget(el('<input type="text">'))).toBe(true);
    expect(isTypingTarget(el("<textarea></textarea>"))).toBe(true);
    expect(isTypingTarget(el("<select></select>"))).toBe(true);
    expect(isTypingTarget(el('<input type="search">'))).toBe(true);
    expect(isTypingTarget(el('<div contenteditable="true"></div>'))).toBe(true);
  });

  it("is false for controls that are not text entry", () => {
    expect(isTypingTarget(el('<input type="checkbox">'))).toBe(false);
    expect(isTypingTarget(el('<input type="radio">'))).toBe(false);
    expect(isTypingTarget(el("<button></button>"))).toBe(false);
    expect(isTypingTarget(el("<div></div>"))).toBe(false);
  });

  it("is false for a null target", () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("formatKeys", () => {
  it("renders platform-appropriate modifiers", () => {
    expect(formatKeys("mod+k", MAC)).toEqual(["⌘K"]);
    expect(formatKeys("mod+k", WIN)).toEqual(["Ctrl K"]);
  });

  it("renders a chord as two separate keycaps", () => {
    expect(formatKeys("g c", WIN)).toEqual(["G", "C"]);
  });

  it("gives named keys their symbols", () => {
    expect(formatKeys("Escape", WIN)).toEqual(["Esc"]);
    expect(formatKeys("ArrowDown", WIN)).toEqual(["↓"]);
    expect(formatKeys("Enter", WIN)).toEqual(["↵"]);
  });
});
