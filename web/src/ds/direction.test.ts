import { describe, it, expect } from "vitest";
import { routeDirection, type RouteRole } from "./direction";

const ROLES: Record<string, RouteRole> = {
  command: "destination",
  chronicle: "destination",
  search: "utility",
  stats: "overflow",
  agents: "drilldown",
  sessions: "drilldown",
  agent: "drilldown",
  run: "drilldown",
};
const roleOf = (id: string) => ROLES[id];

describe("routeDirection", () => {
  it("calls a move between peer destinations lateral — it is not a hierarchy move", () => {
    expect(routeDirection("command", "chronicle", roleOf)).toBe("lateral");
  });

  it("treats utility and overflow tabs as peers of destinations", () => {
    expect(routeDirection("command", "search", roleOf)).toBe("lateral");
    expect(routeDirection("stats", "command", roleOf)).toBe("lateral");
  });

  it("goes forward into a drill-down and back out of one", () => {
    expect(routeDirection("command", "agents", roleOf)).toBe("forward");
    expect(routeDirection("agents", "command", roleOf)).toBe("back");
  });

  it("knows one agent is deeper than the list of agents", () => {
    expect(routeDirection("agents", "agent", roleOf)).toBe("forward");
    expect(routeDirection("agent", "agents", roleOf)).toBe("back");
  });

  it("does not animate a route to itself as a move — that is what a deep-link replace looks like", () => {
    expect(routeDirection("run", "run", roleOf)).toBe("lateral");
  });

  it("treats an unknown route as top level rather than guessing", () => {
    expect(routeDirection("command", "not-a-tab", roleOf)).toBe("lateral");
    expect(routeDirection("agent", "not-a-tab", roleOf)).toBe("back");
  });

  it("is lateral between two drill-downs at the same depth", () => {
    expect(routeDirection("agents", "sessions", roleOf)).toBe("lateral");
  });
});
