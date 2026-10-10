import { describe, it, expect } from "vitest";
import { legacyRedirect } from "./legacyRoutes";

describe("legacyRedirect", () => {
  it("sends the old destinations to where their content went", () => {
    expect(legacyRedirect("#/launch")).toBe("#/schedules/oneoff");
    expect(legacyRedirect("#/monitors")).toBe("#/health");
    expect(legacyRedirect("#/watchtower")).toBe("#/health/watchtower");
    expect(legacyRedirect("#/projects")).toBe("#/sessions");
    expect(legacyRedirect("#/activity")).toBe("#/sessions");
    expect(legacyRedirect("#/tasks")).toBe("#/command");
  });

  it("drops trailing segments the old routes never had a meaning for", () => {
    expect(legacyRedirect("#/monitors/anything")).toBe("#/health");
  });

  it("leaves canonical routes alone, including the ones that absorbed the old", () => {
    expect(legacyRedirect("#/health/watchtower")).toBeNull();
    expect(legacyRedirect("#/schedules/oneoff")).toBeNull();
    expect(legacyRedirect("#/sessions/-home-me-api")).toBeNull();
    expect(legacyRedirect("#/command")).toBeNull();
    expect(legacyRedirect("")).toBeNull();
    expect(legacyRedirect("#/")).toBeNull();
  });
});
