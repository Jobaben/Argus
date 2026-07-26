import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../useSessions";
import { filterSessions, groupSessionsByDay, localDayKey } from "./sessionList";

/** A local-midnight-anchored instant, so these tests do not depend on the
 *  runner's timezone the way a hardcoded UTC string would. */
function localInstant(daysAgo: number, hour = 12, from = new Date(2026, 6, 26, 15, 0, 0)): string {
  return new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate() - daysAgo,
    hour,
  ).toISOString();
}

const NOW = new Date(2026, 6, 26, 15, 0, 0);

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s1",
    project: "-home-me-repo",
    projectLabel: "/home/me/repo",
    title: "Fix the migration",
    messageCount: 12,
    toolUseCount: 4,
    model: "claude-sonnet-4-5",
    firstActivity: localInstant(0, 9),
    lastActivity: localInstant(0, 10),
    ...over,
  };
}

describe("localDayKey", () => {
  it("keys by the reader's own calendar day, not UTC's", () => {
    // 23:30 local is still today for the person reading it, whatever UTC says.
    const late = new Date(2026, 0, 5, 23, 30);
    expect(localDayKey(late)).toBe("2026-01-05");
  });

  it("zero-pads so keys sort lexically", () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("groupSessionsByDay", () => {
  it("names the two days people actually refer to", () => {
    const groups = groupSessionsByDay(
      [
        session({ id: "a", lastActivity: localInstant(0) }),
        session({ id: "b", lastActivity: localInstant(1) }),
      ],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
  });

  it("uses the weekday inside the last week and a date beyond it", () => {
    const groups = groupSessionsByDay(
      [
        session({ id: "a", lastActivity: localInstant(3) }),
        session({ id: "b", lastActivity: localInstant(40) }),
      ],
      NOW,
    );
    // 26 July 2026 is a Sunday, so three days back is the Thursday.
    expect(groups[0].label).toBe("Thursday");
    expect(groups[1].label).toMatch(/2026/);
  });

  it("orders days newest first and sessions newest first inside a day", () => {
    const groups = groupSessionsByDay(
      [
        session({ id: "old-day", lastActivity: localInstant(2) }),
        session({ id: "morning", lastActivity: localInstant(0, 8) }),
        session({ id: "evening", lastActivity: localInstant(0, 14) }),
      ],
      NOW,
    );
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["evening", "morning"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["old-day"]);
  });

  it("keeps an undated transcript instead of dropping it", () => {
    // A transcript we cannot date is still one the user may be looking for.
    const groups = groupSessionsByDay(
      [session({ id: "dated" }), session({ id: "nope", firstActivity: null, lastActivity: null })],
      NOW,
    );
    expect(groups.at(-1)).toMatchObject({ key: "undated" });
    expect(groups.at(-1)?.sessions.map((s) => s.id)).toEqual(["nope"]);
  });

  it("falls back to the first activity when the last is missing", () => {
    const groups = groupSessionsByDay(
      [session({ firstActivity: localInstant(1), lastActivity: null })],
      NOW,
    );
    expect(groups[0].label).toBe("Yesterday");
  });

  it("treats an unparseable timestamp as undated rather than as 1970", () => {
    const groups = groupSessionsByDay(
      [session({ firstActivity: null, lastActivity: "not a date" })],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("undated");
  });
});

describe("filterSessions", () => {
  const sessions = [
    session({ id: "mig", title: "Fix the migration", projectLabel: "/home/me/api" }),
    session({ id: "docs", title: "Rewrite the README", projectLabel: "/home/me/web" }),
    session({ id: "opus", title: "Audit deps", model: "claude-opus-4-1" }),
  ];

  it("returns everything for an empty or whitespace query", () => {
    expect(filterSessions(sessions, "")).toBe(sessions);
    expect(filterSessions(sessions, "   ")).toBe(sessions);
  });

  it("matches a title as a subsequence, like the palette does", () => {
    expect(filterSessions(sessions, "ftm").map((s) => s.id)).toEqual(["mig"]);
  });

  it("matches on the project path", () => {
    expect(filterSessions(sessions, "me/web").map((s) => s.id)).toEqual(["docs"]);
  });

  it("matches on the model", () => {
    expect(filterSessions(sessions, "opus").map((s) => s.id)).toEqual(["opus"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterSessions(sessions, "zzzzq")).toEqual([]);
  });

  it("breaks equal scores by recency", () => {
    const older = session({ id: "older", title: "Deploy", lastActivity: localInstant(5) });
    const newer = session({ id: "newer", title: "Deploy", lastActivity: localInstant(0) });
    expect(filterSessions([older, newer], "deploy").map((s) => s.id)).toEqual(["newer", "older"]);
  });

  it("scores each field on its own, so a long path cannot dilute a title hit", () => {
    const buried = session({
      id: "buried",
      title: "Migration",
      projectLabel: "/very/deeply/nested/monorepo/packages/service/internal",
    });
    const shallow = session({ id: "shallow", title: "Miscellaneous notes", projectLabel: "/m" });
    expect(filterSessions([shallow, buried], "migration")[0].id).toBe("buried");
  });
});
