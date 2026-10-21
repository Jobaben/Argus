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

  it("marks the gate with the approve icon and a sentence-case subtitle", () => {
    const cmd = buildCommands(ctx([gated])).find((c) => c.id === "review:inst-1");
    expect(cmd?.icon).toBe("approve");
    expect(cmd?.subtitle).toBe("See what the paused phase produced, then approve or revise");
  });

  it("names a waiting pipeline 'Needs approval', whatever word the index used", () => {
    for (const badge of ["await", "AWAITING", "awaiting-approval", "needs approval"]) {
      const cmd = buildCommands(ctx([{ ...gated, badge }])).find(
        (c) => c.id === "entry:pipeline:p1",
      );
      expect(cmd?.badge).toBe("Needs approval");
    }
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

describe("buildCommands — labels", () => {
  const entry = (over: Partial<PaletteEntry>): PaletteEntry => ({
    kind: "schedule",
    id: "s1",
    title: "Nightly review",
    subtitle: null,
    href: "#/schedules",
    badge: null,
    severity: "none",
    ...over,
  });
  const only = (e: PaletteEntry) =>
    buildCommands(ctx([e])).find((c) => c.id === `entry:${e.kind}:${e.id}`);

  it("prints status badges in sentence case", () => {
    expect(only(entry({ kind: "pipeline", badge: "running" }))?.badge).toBe("Running");
    expect(only(entry({ kind: "monitor", badge: "down" }))?.badge).toBe("Down");
    expect(only(entry({ kind: "pipeline", badge: "FAILED" }))?.badge).toBe("Failed");
    expect(only(entry({ kind: "schedule", badge: "paused" }))?.badge).toBe("Paused");
    // A count is not a word, and no badge stays no badge.
    expect(only(entry({ kind: "issue", badge: "3×" }))?.badge).toBe("3×");
    expect(only(entry({ badge: null }))?.badge).toBeUndefined();
  });

  it("leaves shortcut badges alone, so the palette still draws them as keycaps", () => {
    const cmds = buildCommands(ctx([]));
    expect(cmds.find((c) => c.id === "go:command")?.badge).toBe("g c");
    expect(cmds.find((c) => c.id === "action:shortcuts")?.badge).toBe("?");
  });

  it("starts every subtitle it wrote with a capital", () => {
    const cmds = buildCommands(ctx([entry({ subtitle: "every 2h", runnableScheduleId: "s1" })]));
    const subtitles = cmds.map((c) => c.subtitle).filter((t): t is string => !!t);
    expect(subtitles.length).toBeGreaterThan(0);
    for (const subtitle of subtitles) expect(subtitle).toMatch(/^[A-Z0-9]/);
    expect(only(entry({ subtitle: "every 2h" }))?.subtitle).toBe("Every 2h");
  });

  it("prints machine text as it came: a working directory, a session's project path", () => {
    expect(only(entry({ kind: "agent", id: "a1", subtitle: "/srv/repos/argus" }))?.subtitle).toBe(
      "/srv/repos/argus",
    );
    expect(only(entry({ kind: "session", id: "s9", subtitle: "home/user/argus" }))?.subtitle).toBe(
      "home/user/argus",
    );
    // A project's subtitle is a phrase the index wrote, not a name.
    expect(only(entry({ kind: "project", id: "p1", subtitle: "3 sessions" }))?.subtitle).toBe(
      "3 sessions",
    );
  });
});
