/**
 * Constellation: N machines, one lens.
 *
 * Argus watches one `~/.claude`. Anyone who runs it on a laptop and a build box
 * runs it twice and reads it twice, and the questions that matter across both —
 * what is failing anywhere, what am I spending in total — have no home.
 *
 * The shape is deliberately **peer-to-peer with no server**. Each machine
 * publishes a small summary of itself and pulls its peers'. There is no
 * coordinator to run, nothing to host, and no machine that is more trusted than
 * the others — which is the only federation design that does not turn a local
 * monitoring tool into infrastructure.
 *
 * **Single-machine stays zero-config.** With no peers configured nothing here
 * runs, nothing is published, and the fleet view shows one machine: yours.
 * Federation is something you opt into per peer, by pairing.
 *
 * **Pairing is mutual and secret-based.** Two machines exchange a pairing
 * secret out of band; every request and every response between them is
 * encrypted and signed with keys derived from it. A peer with the wrong secret
 * is not a degraded peer, it is not a peer — and Argus refuses to boot with a
 * peer configured over a non-loopback URL and no secret, the same way it
 * refuses an exposed bind without a token.
 */

/** A peer's pipeline instance, as much of it as the board needs. */
export interface PeerPipeline {
  id: string;
  name: string;
  status: string;
  /** The phase it is at, when it is at one. */
  phase: string | null;
}

/** A peer's open issue, as much of it as the list needs. */
export interface PeerIssue {
  fingerprint: string;
  title: string;
  count: number;
  lastSeen: string;
}

/** A peer's recent run, as much of it as the timeline needs. */
export interface PeerRun {
  id: string;
  label: string;
  status: string;
  at: string;
  durationMs: number | null;
}

/** A peer's budget position. */
export interface PeerBudget {
  state: string;
  dailyLimitUsd: number | null;
  monthlyLimitUsd: number | null;
}

/**
 * The detail the fleet-wide views need, bounded on every axis.
 *
 * A deliberate revision of an earlier, stricter choice. The first version of
 * this feature sent counts only, on the grounds that a summary crosses a
 * network — but counts cannot make Command Center, Chronicle, Issues and Budget
 * fleet-wide, which is the point of federating them, and a fleet view that can
 * only say "seven issues somewhere" is a worse product than one that names
 * them.
 *
 * What makes it safe is not the absence of detail, it is who receives it: a
 * summary only ever goes to a machine you explicitly paired with, sealed with a
 * secret you carried between them by hand. Within that, the bounds still hold —
 * every list is capped, every string clamped, and prompts, working directories
 * and session ids never travel at all. Opening a run means opening that
 * machine's own Argus.
 */
export interface MachineFacets {
  pipelines: PeerPipeline[];
  issues: PeerIssue[];
  recentRuns: PeerRun[];
  budget: PeerBudget;
}

/** What a summary says about one machine. Small on purpose. */
export interface MachineSummary {
  /** Stable, locally generated, and not derived from anything identifying. */
  machineId: string;
  label: string;
  version: string;
  generatedAt: string;
  schedules: number;
  /** Monitors that are down or failing right now. */
  monitorsDown: number;
  monitorsFailing: number;
  openIssues: number;
  liveInstances: number;
  gatedInstances: number;
  runsToday: number;
  failuresToday: number;
  spendTodayUsd: number;
  spendMonthUsd: number;
  /** Highest-severity open incident, when there is one. */
  worstIncident: string | null;
  /** Bounded detail for the fleet-wide views. */
  facets: MachineFacets;
}

export type PeerStatus =
  /** Answering, and the answer verified. */
  | "paired"
  /** Configured but never yet reached. */
  | "pending"
  /** Reachable, but the envelope did not verify — usually a mismatched secret. */
  | "unauthorized"
  /** Not reachable at all. */
  | "unreachable"
  /** Last answer is older than the staleness window. */
  | "stale";

export interface Peer {
  id: string;
  label: string;
  /** Base URL of the peer's Argus, e.g. `http://buildbox.local:7777`. */
  url: string;
  status: PeerStatus;
  lastSeenAt: string | null;
  /** Why the last attempt failed, when it did. */
  error: string | null;
  addedAt: string;
}

/** One machine in the fleet view: who it is, and what it last said. */
export interface FleetMachine {
  peer: Peer;
  /** Null until a verified summary has been received. */
  summary: MachineSummary | null;
  /** True for the machine serving this request. */
  isSelf: boolean;
}

export interface FleetTotals {
  machines: number;
  reporting: number;
  monitorsDown: number;
  monitorsFailing: number;
  openIssues: number;
  liveInstances: number;
  gatedInstances: number;
  runsToday: number;
  failuresToday: number;
  spendTodayUsd: number;
  spendMonthUsd: number;
}

export interface FleetView {
  /** Self first, then peers by label. */
  machines: FleetMachine[];
  totals: FleetTotals;
  /**
   * True when no peers are configured. The UI uses this to stay quiet rather
   * than showing a fleet of one and implying something is missing.
   */
  soloMode: boolean;
  generatedAt: string;
}

/** What a peer is added with. The secret is write-only over the API. */
export interface PeerInput {
  label: string;
  url: string;
  /** Shared pairing secret, hex. Never returned by any read. */
  secret: string;
}

/** A freshly minted pairing secret, shown once so it can be carried to the peer. */
export interface PairingCode {
  secret: string;
  /** What to run on the other machine, ready to copy. */
  instructions: string;
}
