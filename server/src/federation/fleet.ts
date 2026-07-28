import type { FleetMachine, FleetTotals, FleetView, MachineSummary, Peer } from "@argus/contracts";

/**
 * Assembling the fleet view.
 *
 * Pure, and the interesting decisions are all about what a total means when
 * some machines are not answering.
 */

export type { FleetMachine, FleetTotals, FleetView, MachineSummary } from "@argus/contracts";

const ZERO: FleetTotals = {
  machines: 0,
  reporting: 0,
  monitorsDown: 0,
  monitorsFailing: 0,
  openIssues: 0,
  liveInstances: 0,
  gatedInstances: 0,
  runsToday: 0,
  failuresToday: 0,
  spendTodayUsd: 0,
  spendMonthUsd: 0,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Totals across every machine that is currently reporting.
 *
 * `machines` and `reporting` are both returned, and the difference between them
 * is the point: a fleet total computed from three of five machines is not a
 * fleet total, and the UI needs to be able to say so. Silently summing what
 * happens to be reachable is how "spend is fine" becomes wrong on the day a
 * machine goes quiet — which is exactly the day it matters.
 */
export function fleetTotals(machines: FleetMachine[]): FleetTotals {
  const totals = { ...ZERO, machines: machines.length };
  for (const m of machines) {
    if (!m.summary) continue;
    totals.reporting++;
    totals.monitorsDown += m.summary.monitorsDown;
    totals.monitorsFailing += m.summary.monitorsFailing;
    totals.openIssues += m.summary.openIssues;
    totals.liveInstances += m.summary.liveInstances;
    totals.gatedInstances += m.summary.gatedInstances;
    totals.runsToday += m.summary.runsToday;
    totals.failuresToday += m.summary.failuresToday;
    totals.spendTodayUsd += m.summary.spendTodayUsd;
    totals.spendMonthUsd += m.summary.spendMonthUsd;
  }
  totals.spendTodayUsd = round2(totals.spendTodayUsd);
  totals.spendMonthUsd = round2(totals.spendMonthUsd);
  return totals;
}

export function buildFleet(
  self: MachineSummary,
  peers: Peer[],
  summaries: Map<string, MachineSummary>,
  now: Date,
): FleetView {
  const selfMachine: FleetMachine = {
    isSelf: true,
    summary: self,
    peer: {
      id: self.machineId,
      label: self.label,
      url: "",
      status: "paired",
      lastSeenAt: self.generatedAt,
      error: null,
      addedAt: self.generatedAt,
    },
  };
  // Self first, always. It is the machine the reader is looking at, and sorting
  // it into the middle of an alphabetical list makes the page feel like it is
  // about somewhere else.
  const machines: FleetMachine[] = [
    selfMachine,
    ...peers.map((peer) => ({
      peer,
      // A peer whose last answer has gone stale keeps its summary on screen,
      // marked stale, rather than blanking. "Last known, ten minutes ago" is
      // information; an empty card is not.
      summary: summaries.get(peer.id) ?? null,
      isSelf: false,
    })),
  ];

  return {
    machines,
    totals: fleetTotals(machines),
    soloMode: peers.length === 0,
    generatedAt: now.toISOString(),
  };
}
