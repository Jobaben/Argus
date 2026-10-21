import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isChunkLoadError, reloadForNewBuild } from "./staleBuild";

describe("isChunkLoadError", () => {
  it("recognises each browser's failed dynamic import", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: http://localhost:7777/assets/AdminAuthPanel-BEi5GaaH.js",
      "error loading dynamically imported module: http://localhost:7777/assets/Chronicle-x.js",
      "Importing a module script failed.",
    ]) {
      expect(isChunkLoadError(new Error(message))).toBe(true);
    }
  });

  it("leaves ordinary view crashes alone", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
  });
});

describe("reloadForNewBuild", () => {
  const reload = vi.fn();
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("location", { ...window.location, reload });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    reload.mockReset();
  });

  it("reloads once, then refuses to loop", () => {
    expect(reloadForNewBuild()).toBe(true);
    expect(reloadForNewBuild()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
