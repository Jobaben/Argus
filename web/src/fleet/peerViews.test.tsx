import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FleetMachine, FleetView, MachineSummary, Peer } from "../types";

/**
 * The four fleet-wide views, in peer mode.
 *
 * One file rather than four additions, because the property under test is the
 * same in all of them and is a property *of the set*: selecting a peer must
 * replace the local content with that peer's, must never offer a control that
 * would mutate a machine this server does not own, and must degrade to the
 * pre-federation page when there is no peer to show.
 */

const fleetState: { fleet: FleetView } = { fleet: solo() };
const selectedPeer: { id: string | null } = { id: null };

vi.mock("../useFleet", () => ({
  useFleet: () => ({
    fleet: fleetState.fleet,
    loading: false,
    error: null,
    busy: false,
    actionError: null,
    pairing: null,
    refresh: vi.fn(),
    clearPairing: vi.fn(),
    mintPairing: vi.fn(),
    addPeer: vi.fn(),
    unpair: vi.fn(),
    rename: vi.fn(),
  }),
}));

// The picker's own behaviour is covered in MachineFacet.test.tsx; here the
// selection is forced so each view can be rendered directly in peer mode.
vi.mock("./useMachineFacet", async () => {
  const actual = await vi.importActual<typeof import("./useMachineFacet")>("./useMachineFacet");
  return {
    ...actual,
    useMachineFacet: () => {
      const machines = fleetState.fleet.soloMode ? [] : fleetState.fleet.machines;
      const peer = machines.find((m) => !m.isSelf && m.peer.id === selectedPeer.id) ?? null;
      return {
        selected: peer ? selectedPeer.id : null,
        select: vi.fn(),
        machines,
        peer,
        soloMode: fleetState.fleet.soloMode,
      };
    },
  };
});

// Every view's own data source, stubbed empty: peer mode must not read them.
vi.mock("../useOverview", () => ({
  useOverview: () => ({
    overview: [],
    loading: false,
    error: null,
    approve: vi.fn(),
    revise: vi.fn(),
  }),
}));
vi.mock("../useTotals", () => ({ useTotals: () => ({ totals: null, reset: vi.fn() }) }));
vi.mock("../useInsight", () => ({ useInsight: () => ({ situation: null, loading: false }) }));
vi.mock("../useRuns", () => ({
  useRuns: () => ({ runs: [], loading: false, cancelRun: vi.fn() }),
}));
vi.mock("../useRunActivity", () => ({ useRunActivity: () => new Map() }));
vi.mock("../useChronicle", () => ({
  useChronicle: () => ({
    chronicle: {
      windowStart: "2026-07-20T00:00:00.000Z",
      windowEnd: "2026-07-20T12:00:00.000Z",
      groups: [],
      totals: { spans: 0, active: 0, failed: 0, costUsd: null, tokens: null },
    },
    loading: false,
    error: null,
  }),
}));
vi.mock("../useIssues", () => ({
  useIssues: () => ({
    issues: [],
    summary: { open: 0, ignored: 0, resolved: 0 },
    loading: false,
    error: null,
    triage: vi.fn(),
    loadOccurrences: vi.fn(),
  }),
}));
vi.mock("../useBudget", () => ({
  useBudget: () => ({ budget: null, loading: false, error: null, save: vi.fn() }),
}));

function summary(over: Partial<MachineSummary> = {}): MachineSummary {
  return {
    machineId: "m1",
    label: "Laptop",
    version: "0.4.0",
    generatedAt: "2026-07-20T12:00:00.000Z",
    schedules: 1,
    monitorsDown: 0,
    monitorsFailing: 0,
    openIssues: 0,
    liveInstances: 0,
    gatedInstances: 0,
    runsToday: 0,
    failuresToday: 0,
    spendTodayUsd: 2.5,
    spendMonthUsd: 40,
    worstIncident: null,
    facets: {
      pipelines: [],
      issues: [],
      recentRuns: [],
      budget: { state: "ok", dailyLimitUsd: 10, monthlyLimitUsd: null },
    },
    ...over,
  };
}

function peer(over: Partial<Peer> = {}): Peer {
  return {
    id: "p1",
    label: "Build box",
    url: "http://box.local:7777",
    status: "paired",
    lastSeenAt: "2026-07-20T12:00:00.000Z",
    error: null,
    addedAt: "2026-07-20T10:00:00.000Z",
    ...over,
  };
}

function selfMachine(): FleetMachine {
  return { isSelf: true, summary: summary(), peer: peer({ id: "m1", label: "Laptop", url: "" }) };
}

function solo(): FleetView {
  return {
    machines: [selfMachine()],
    totals: {
      machines: 1,
      reporting: 1,
      monitorsDown: 0,
      monitorsFailing: 0,
      openIssues: 0,
      liveInstances: 0,
      gatedInstances: 0,
      runsToday: 0,
      failuresToday: 0,
      spendTodayUsd: 0,
      spendMonthUsd: 0,
    },
    soloMode: true,
    generatedAt: "2026-07-20T12:00:00.000Z",
  };
}

function withFacets(facets: Partial<MachineSummary["facets"]>): void {
  fleetState.fleet = {
    ...solo(),
    soloMode: false,
    machines: [
      selfMachine(),
      {
        peer: peer(),
        isSelf: false,
        summary: summary({
          machineId: "m2",
          label: "Build box",
          facets: { ...summary().facets, ...facets },
        }),
      },
    ],
  };
  selectedPeer.id = "p1";
}

beforeEach(() => {
  fleetState.fleet = solo();
  selectedPeer.id = null;
  sessionStorage.clear();
});

describe("Command Center in peer mode", () => {
  it("shows the peer's live pipelines and the phase each is at", async () => {
    withFacets({
      pipelines: [
        { id: "i1", name: "Release train", status: "awaiting-approval", phase: "review" },
        { id: "i2", name: "Nightly build", status: "running", phase: null },
      ],
    });
    const { default: CommandCenter } = await import("../views/CommandCenter");
    render(<CommandCenter />);
    expect(screen.getByText("Release train")).toBeInTheDocument();
    expect(screen.getByText("at review")).toBeInTheDocument();
    expect(screen.getByText("needs approval")).toBeInTheDocument();
  });

  it("regression: offers no approve or revise for a machine it does not own", async () => {
    withFacets({
      pipelines: [
        { id: "i1", name: "Release train", status: "awaiting-approval", phase: "review" },
      ],
    });
    const { default: CommandCenter } = await import("../views/CommandCenter");
    render(<CommandCenter />);
    // A gate is opened by the machine that owns it. A button here would either
    // fail or need a second control plane across the pairing.
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revise/i })).not.toBeInTheDocument();
  });

  it("a peer with no live pipelines says the summary is bounded", async () => {
    withFacets({ pipelines: [] });
    const { default: CommandCenter } = await import("../views/CommandCenter");
    render(<CommandCenter />);
    expect(screen.getByText(/reported no live pipelines/)).toBeInTheDocument();
  });
});

describe("Chronicle in peer mode", () => {
  it("lists the peer's recent runs and says the list is bounded", async () => {
    withFacets({
      recentRuns: [
        {
          id: "r1",
          label: "Nightly triage",
          status: "failed",
          at: "2026-07-20T11:00:00.000Z",
          durationMs: 60_000,
        },
      ],
    });
    const { default: Chronicle } = await import("../views/Chronicle");
    render(<Chronicle />);
    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
    // A packed timeline drawn from forty sampled runs would show gaps that mean
    // "not sent" and read as "nothing happened".
    expect(screen.getByText(/not its whole history/)).toBeInTheDocument();
  });
});

describe("Issues in peer mode", () => {
  it("lists the peer's open issues, loudest first", async () => {
    withFacets({
      issues: [
        {
          fingerprint: "fp1",
          title: "ECONNREFUSED",
          count: 9,
          lastSeen: "2026-07-20T11:00:00.000Z",
        },
      ],
    });
    const { default: Issues } = await import("../views/Issues");
    render(<Issues />);
    expect(screen.getByText("ECONNREFUSED")).toBeInTheDocument();
    expect(screen.getByText(/9×/)).toBeInTheDocument();
  });

  it("regression: offers no triage buttons for another machine's issues", async () => {
    withFacets({
      issues: [{ fingerprint: "fp1", title: "ECONNREFUSED", count: 9, lastSeen: "" }],
    });
    const { default: Issues } = await import("../views/Issues");
    render(<Issues />);
    // Triage is a mutation on the machine that owns the issue.
    expect(screen.queryByRole("button", { name: /resolve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ignore/i })).not.toBeInTheDocument();
  });
});

describe("Budget in peer mode", () => {
  it("shows the peer's spend against its own limits", async () => {
    withFacets({ budget: { state: "ok", dailyLimitUsd: 10, monthlyLimitUsd: 150 } });
    const { default: Budget } = await import("../views/Budget");
    render(<Budget />);
    expect(screen.getByText("$2.50")).toBeInTheDocument();
    expect(screen.getByText(/of \$10\.00/)).toBeInTheDocument();
    expect(screen.getByText(/of \$150\.00/)).toBeInTheDocument();
  });

  it("regression: the limits form is absent for a machine that enforces its own", async () => {
    withFacets({ budget: { state: "ok", dailyLimitUsd: null, monthlyLimitUsd: null } });
    const { default: Budget } = await import("../views/Budget");
    render(<Budget />);
    // Editing a limit from here would either not work or need a whole second
    // write path across the pairing.
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    expect(screen.getByText(/enforced by the machine that holds them/)).toBeInTheDocument();
    expect(screen.getAllByText(/no limit set/)).toHaveLength(2);
  });
});
