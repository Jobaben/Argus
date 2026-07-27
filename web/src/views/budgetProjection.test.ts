import { describe, expect, it } from "vitest";
import { projectMonth } from "./budgetProjection";

/** 15 January 2026, mid-month: 15 days elapsed of 31. */
const MID_JAN = new Date(2026, 0, 15, 12);

function window(spentUsd: number, limitUsd: number | null = null) {
  return { spentUsd, limitUsd, ratio: limitUsd ? spentUsd / limitUsd : null };
}

describe("projectMonth", () => {
  it("straight-lines the elapsed rate across the whole month", () => {
    // $30 over 15 days is $2/day; 31 days is $62.
    const p = projectMonth(window(30), MID_JAN);
    expect(p?.perDayUsd).toBeCloseTo(2);
    expect(p?.projectedUsd).toBeCloseTo(62);
    expect(p?.daysInMonth).toBe(31);
    expect(p?.daysElapsed).toBe(15);
  });

  it("says nothing when there is no spend to project from", () => {
    // A projection from zero data is a guess dressed as a number.
    expect(projectMonth(window(0), MID_JAN)).toBeNull();
    expect(projectMonth(window(0, 100), MID_JAN)).toBeNull();
  });

  it("knows a month's real length, including a leap February", () => {
    expect(projectMonth(window(10), new Date(2026, 1, 10))?.daysInMonth).toBe(28);
    expect(projectMonth(window(10), new Date(2028, 1, 10))?.daysInMonth).toBe(29);
    expect(projectMonth(window(10), new Date(2026, 3, 10))?.daysInMonth).toBe(30);
  });

  it("flags a projection that clears the limit and one that does not", () => {
    expect(projectMonth(window(30, 100), MID_JAN)?.overLimit).toBe(false); // $62 of $100
    expect(projectMonth(window(30, 50), MID_JAN)?.overLimit).toBe(true); // $62 of $50
  });

  it("names the day the limit is projected to be crossed", () => {
    // $2/day against a $50 limit crosses during day 25.
    const p = projectMonth(window(30, 50), MID_JAN);
    expect(p?.exhaustsOn?.getDate()).toBe(25);
    expect(p?.exhaustsOn?.getMonth()).toBe(0);
  });

  it("rounds the crossing day up, never into the reassuring direction", () => {
    // $2/day against $51 crosses partway through day 26, not at the end of 25.
    expect(projectMonth(window(30, 51), MID_JAN)?.exhaustsOn?.getDate()).toBe(26);
  });

  it("has no crossing day when the limit is not reached this month", () => {
    expect(projectMonth(window(30, 1000), MID_JAN)?.exhaustsOn).toBeNull();
  });

  it("has no crossing day without a usable limit", () => {
    expect(projectMonth(window(30), MID_JAN)?.exhaustsOn).toBeNull();
    expect(projectMonth(window(30, 0), MID_JAN)?.exhaustsOn).toBeNull();
  });

  it("reports a crossing already behind us as a day in this month, not day zero", () => {
    // Spend has blown a tiny limit on day one; the date must stay valid.
    const p = projectMonth(window(500, 1), MID_JAN);
    expect(p?.exhaustsOn?.getDate()).toBe(1);
    expect(p?.overLimit).toBe(true);
  });

  it("projects from a single elapsed day without dividing by zero", () => {
    const p = projectMonth(window(5), new Date(2026, 0, 1, 3));
    expect(p?.perDayUsd).toBeCloseTo(5);
    expect(p?.projectedUsd).toBeCloseTo(155);
  });
});
