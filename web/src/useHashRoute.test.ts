import { describe, it, expect, beforeEach } from "vitest";
import { hashSegments } from "./useHashRoute";

describe("hashSegments", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("returns [] at the root", () => {
    window.location.hash = "#/";
    expect(hashSegments()).toEqual([]);
  });

  it("splits and decodes path segments", () => {
    window.location.hash = "#/sessions/-home-user-proj/sess-1";
    expect(hashSegments()).toEqual(["sessions", "-home-user-proj", "sess-1"]);
  });

  it("decodes percent-encoded segments", () => {
    window.location.hash = `#/sessions/${encodeURIComponent("a/b")}/id`;
    expect(hashSegments()).toEqual(["sessions", "a/b", "id"]);
  });
});
