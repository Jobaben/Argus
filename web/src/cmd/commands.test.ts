import { describe, it, expect, vi } from "vitest";
import { buildCommands, type CommandContext } from "./commands";
import type { PaletteEntry } from "../types";

function ctx(entries: PaletteEntry[], canAdmin = false): CommandContext {
  return {
    destinations: [{ id: "command", label: "Command Center", chord: "g c" }],
    entries,
    canAdmin,
    actions: {
      runSchedule: vi.fn(() => Promise.resolve()),
      markCaughtUp: vi.fn(() => Promise.resolve()),
      showShortcuts: vi.fn(),
    },
  };
}

const gated: PaletteEntry = {
  kind: "pipeline",
  id: "p1",
  title: "Release train",
  subtitle: "3 phases · manual",
  href: "#/command",
  badge: "await",
  severity: "warn",
  gateInstanceId: "inst-1",
};

describe("buildCommands — gates", () => {
  it("offers a gate as a navigation to the review drawer, never as a blind action", () => {
    const cmd = buildCommands(ctx([gated])).find((c) => c.id === "review:inst-1");
    expect(cmd).toBeDefined();
    expect(cmd?.title).toBe("Review gate — Release train");
    expect(cmd?.group).toBe("Actions");
    expect(cmd?.href).toBe("#/command/inst-1");
    expect(cmd?.run).toBeUndefined();
    expect(cmd?.keywords).toEqual(expect.arrayContaining(["approve", "revise", "review"]));
  });

  it("has no approve command at all, signed in or not", () => {
    for (const canAdmin of [false, true]) {
      const ids = buildCommands(ctx([gated], canAdmin)).map((c) => c.id);
      expect(ids.some((id) => id.startsWith("approve:"))).toBe(false);
      expect(ids).toContain("review:inst-1");
    }
  });

  it("offers nothing for a pipeline that is not waiting", () => {
    const ids = buildCommands(ctx([{ ...gated, gateInstanceId: undefined }])).map((c) => c.id);
    expect(ids.some((id) => id.startsWith("review:"))).toBe(false);
  });
});
