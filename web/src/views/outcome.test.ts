import { describe, expect, it } from "vitest";
import { firstProseLine, splitOutcome, withoutOutcome } from "./outcome";

describe("splitOutcome", () => {
  it("takes the marker off the prose and keeps its verdict", () => {
    expect(splitOutcome("Drafted the changelog.\nARGUS_OUTCOME: succeeded")).toEqual({
      prose: "Drafted the changelog.",
      outcome: "succeeded",
    });
  });

  it("keeps the marker's reason when the marker is all there is", () => {
    expect(splitOutcome("ARGUS_OUTCOME: failed tests are red")).toEqual({
      prose: "tests are red",
      outcome: "failed",
    });
  });

  it("reads an indented or lower-case marker as the server does", () => {
    expect(splitOutcome("Done\n  argus_outcome: blocked waiting on a token").outcome).toBe(
      "blocked",
    );
  });

  it("reads a marker on a CRLF line", () => {
    expect(splitOutcome("Done\r\nARGUS_OUTCOME: failed lint is red\r\n")).toEqual({
      prose: "Done",
      outcome: "failed",
    });
  });

  it("leaves text without a marker alone", () => {
    expect(splitOutcome("  exit code 1  ")).toEqual({ prose: "exit code 1", outcome: null });
    expect(splitOutcome(null)).toEqual({ prose: "", outcome: null });
  });

  it("does not take a mention of the marker inside a sentence for the marker", () => {
    const text = "It must end with ARGUS_OUTCOME: succeeded";
    expect(withoutOutcome(text)).toBe(text);
  });
});

describe("firstProseLine", () => {
  it("skips blank lines and the marker", () => {
    expect(firstProseLine("\n\nARGUS_OUTCOME: failed\n  Build broke  \nmore")).toBe("Build broke");
  });

  it("falls back to the marker's reason, then to nothing", () => {
    expect(firstProseLine("ARGUS_OUTCOME: failed lint")).toBe("lint");
    expect(firstProseLine("ARGUS_OUTCOME: succeeded")).toBe("");
    expect(firstProseLine(undefined)).toBe("");
  });
});
