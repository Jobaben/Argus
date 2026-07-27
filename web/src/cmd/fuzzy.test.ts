import { describe, it, expect } from "vitest";
import { fuzzyMatch, highlight, rank } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches a subsequence, not just a substring", () => {
    expect(fuzzyMatch("dpa", "Dependency audit")).not.toBeNull();
    expect(fuzzyMatch("rt", "Release train")).not.toBeNull();
  });

  it("rejects a query whose characters are out of order or absent", () => {
    expect(fuzzyMatch("adp", "Dependency audit")).toBeNull();
    expect(fuzzyMatch("xyz", "Dependency audit")).toBeNull();
  });

  it("rejects a query longer than the target", () => {
    expect(fuzzyMatch("dependency audit sweep", "audit")).toBeNull();
  });

  it("returns the matched positions so a caller can highlight them", () => {
    expect(fuzzyMatch("dep", "Dependency audit")?.positions).toEqual([0, 1, 2]);
    expect(fuzzyMatch("da", "Dependency audit")?.positions).toEqual([0, 11]);
  });

  it("ignores spaces in the query so typing between words still matches", () => {
    expect(fuzzyMatch("dep aud", "Dependency audit")?.positions).toEqual([0, 1, 2, 11, 12, 13]);
  });

  it("treats an empty query as a match with no positions", () => {
    expect(fuzzyMatch("  ", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("scores word initials above the same letters mid-word", () => {
    const initials = fuzzyMatch("rt", "Release train")!.score;
    const midWord = fuzzyMatch("rt", "Chronicle report")!.score;
    expect(initials).toBeGreaterThan(midWord);
  });

  it("scores a consecutive run above a scattered match", () => {
    const run = fuzzyMatch("moni", "Monitors")!.score;
    const scattered = fuzzyMatch("moni", "Morning standup digest is nice")!.score;
    expect(run).toBeGreaterThan(scattered);
  });

  it("prefers a match at the start over the same match buried later", () => {
    const early = fuzzyMatch("issue", "Issues")!.score;
    const late = fuzzyMatch("issue", "Nightly review of every issue")!.score;
    expect(early).toBeGreaterThan(late);
  });

  it("is case-insensitive but rewards an exact-case hit", () => {
    expect(fuzzyMatch("MONITORS", "monitors")).not.toBeNull();
    const exact = fuzzyMatch("Mon", "Monitors")!.score;
    const inexact = fuzzyMatch("mon", "Monitors")!.score;
    expect(exact).toBeGreaterThan(inexact);
  });

  it("matches across path and kebab separators as word starts", () => {
    expect(fuzzyMatch("ncr", "nightly-code-review")).not.toBeNull();
    expect(fuzzyMatch("hmg", "home/mtrushbad/GIT")).not.toBeNull();
  });
});

describe("highlight", () => {
  it("splits the target into matched and unmatched runs", () => {
    expect(highlight("Monitors", [0, 1, 2])).toEqual([
      { text: "Mon", match: true },
      { text: "itors", match: false },
    ]);
  });

  it("handles a match that is not at the start and is discontinuous", () => {
    expect(highlight("abcd", [1, 3])).toEqual([
      { text: "a", match: false },
      { text: "b", match: true },
      { text: "c", match: false },
      { text: "d", match: true },
    ]);
  });

  it("returns one unmatched segment when nothing matched", () => {
    expect(highlight("Monitors", [])).toEqual([{ text: "Monitors", match: false }]);
  });
});

describe("rank", () => {
  const items = [
    { title: "Command Center" },
    { title: "Monitors" },
    { title: "Dependency audit", subtitle: "every 6h · spectacle" },
    { title: "Release train", subtitle: "daily at 23:00" },
    { title: "Morning standup digest", keywords: ["schedule", "docs"] },
  ];

  it("keeps the caller's order for an empty query, so curation shows through", () => {
    expect(rank("", items).map((r) => r.item.title)).toEqual(items.map((i) => i.title));
  });

  it("drops non-matches", () => {
    expect(rank("zzz", items)).toEqual([]);
  });

  it("puts the obvious answer first for a short abbreviation", () => {
    expect(rank("dpa", items)[0].item.title).toBe("Dependency audit");
    expect(rank("rt", items)[0].item.title).toBe("Release train");
    expect(rank("cc", items)[0].item.title).toBe("Command Center");
  });

  it("finds a row by its subtitle, ranked below a title hit", () => {
    const bySubtitle = rank("23:00", items);
    expect(bySubtitle[0].item.title).toBe("Release train");
    // A subtitle hit highlights nothing in the title.
    expect(bySubtitle[0].positions).toEqual([]);
  });

  it("finds a row by an invisible keyword", () => {
    expect(rank("docs", items)[0].item.title).toBe("Morning standup digest");
  });

  it("prefers a title match over a subtitle match of the same text", () => {
    const ranked = rank("spectacle", [
      { title: "spectacle" },
      { title: "Dependency audit", subtitle: "every 6h · spectacle" },
    ]);
    expect(ranked[0].item.title).toBe("spectacle");
  });

  it("returns title positions for highlighting", () => {
    expect(rank("mon", items)[0].positions).toEqual([0, 1, 2]);
  });
});
