/**
 * Which way the user just went.
 *
 * Every route change in Argus used to be the same flat crossfade, so a deep app
 * — Command Center → agent tile → agent detail → run → Flight Recorder → step
 * drawer — had no geography: each screen replaced the last like slides in a deck.
 * Motion can answer three questions preconsciously that no label answers as
 * fast: where did this come from, where did the old thing go, and how do I get
 * back. Direction is the input to all three.
 *
 * It is derived from the nav metadata that already exists — a tab's `role` — so
 * there is no second table to keep in step with the first. A tab declared as a
 * `drilldown` is deeper than a destination; that is all the grammar needs.
 */

export type RouteDirection = "forward" | "back" | "lateral";

/** The nav roles, as depth. Destinations are peers; drill-downs are below them. */
export type RouteRole = "destination" | "utility" | "overflow" | "drilldown";

const DEPTH: Record<RouteRole, number> = {
  destination: 0,
  utility: 0,
  overflow: 0,
  drilldown: 1,
};

/**
 * Routes that are a level deeper than a plain drill-down.
 *
 * `#/agents` is a board; `#/agent/x` is one agent from it; `#/run/x` is one run
 * from *that*. Treating all three as one depth would animate agents → detail as
 * a lateral move, which is precisely the relationship worth showing.
 */
const EXTRA_DEPTH: Record<string, number> = { agent: 1, run: 1 };

function depthOf(tabId: string, roleOf: (tabId: string) => RouteRole | undefined): number {
  const role = roleOf(tabId);
  if (role === undefined) return 0;
  return DEPTH[role] + (EXTRA_DEPTH[tabId] ?? 0);
}

/**
 * `forward` when the new route is deeper, `back` when it is shallower,
 * `lateral` between peers — including a route to itself, which is what a
 * deep-link replace looks like and must not be animated as a move.
 */
export function routeDirection(
  from: string,
  to: string,
  roleOf: (tabId: string) => RouteRole | undefined,
): RouteDirection {
  if (from === to) return "lateral";
  const a = depthOf(from, roleOf);
  const b = depthOf(to, roleOf);
  if (b > a) return "forward";
  if (b < a) return "back";
  return "lateral";
}
