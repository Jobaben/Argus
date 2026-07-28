import { describe, it, expect } from "vitest";
import { looksLikeIntent } from "./intent";

describe("looksLikeIntent", () => {
  it("a name or a fragment stays a search", () => {
    // These are what the palette is *for*. Offering to spend a planning pass on
    // them would make the fast path slower and more expensive.
    for (const q of ["nightly", "nightly triage", "spectacle", "#/budget", "ftm"]) {
      expect(looksLikeIntent(q)).toBe(false);
    }
  });

  it("a sentence is offered as an instruction", () => {
    for (const q of [
      "pause everything touching Spectacle",
      "set the daily budget to 5 dollars",
      "resolve the registry timeout issue",
    ]) {
      expect(looksLikeIntent(q)).toBe(true);
    }
  });

  it("regression: three short words are not a sentence", () => {
    // "a b c" clears the word count and nothing else. Both thresholds have to
    // hold or a stray space turns a search into a paid model call.
    expect(looksLikeIntent("a b c")).toBe(false);
    expect(looksLikeIntent("   ")).toBe(false);
  });

  it("leading and trailing space does not change the answer", () => {
    expect(looksLikeIntent("   pause the nightly triage   ")).toBe(true);
  });
});
