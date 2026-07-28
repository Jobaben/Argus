import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FleetMachine, FleetView, MachineSummary, PairingCode, Peer } from "../types";
import Fleet from "./Fleet";

const actions = {
  mintPairing: vi.fn(async () => {}),
  addPeer: vi.fn(async () => {}),
  unpair: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  clearPairing: vi.fn(),
};

const state: {
  fleet: FleetView;
  loading: boolean;
  error: string | null;
  actionError: string | null;
  pairing: PairingCode | null;
} = {
  fleet: solo(),
  loading: false,
  error: null,
  actionError: null,
  pairing: null,
};

vi.mock("../useFleet", () => ({
  useFleet: () => ({ ...state, busy: false, refresh: vi.fn(), ...actions }),
}));

function summary(over: Partial<MachineSummary> = {}): MachineSummary {
  return {
    machineId: "m1",
    label: "Laptop",
    version: "0.4.0",
    generatedAt: "2026-07-20T12:00:00.000Z",
    schedules: 3,
    monitorsDown: 0,
    monitorsFailing: 0,
    openIssues: 0,
    liveInstances: 0,
    gatedInstances: 0,
    runsToday: 4,
    failuresToday: 0,
    spendTodayUsd: 1.25,
    spendMonthUsd: 30,
    worstIncident: null,
    facets: {
      pipelines: [],
      issues: [],
      recentRuns: [],
      budget: { state: "ok", dailyLimitUsd: null, monthlyLimitUsd: null },
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
  return {
    isSelf: true,
    summary: summary(),
    peer: peer({ id: "m1", label: "Laptop", url: "", status: "paired" }),
  };
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
      runsToday: 4,
      failuresToday: 0,
      spendTodayUsd: 1.25,
      spendMonthUsd: 30,
    },
    soloMode: true,
    generatedAt: "2026-07-20T12:00:00.000Z",
  };
}

function fleetOf(machines: FleetMachine[], reporting: number): FleetView {
  return {
    ...solo(),
    machines,
    soloMode: false,
    totals: {
      ...solo().totals,
      machines: machines.length,
      reporting,
      openIssues: 5,
      spendTodayUsd: 3.75,
    },
  };
}

beforeEach(() => {
  state.fleet = solo();
  state.loading = false;
  state.error = null;
  state.actionError = null;
  state.pairing = null;
  Object.values(actions).forEach((fn) => fn.mockClear());
});

describe("Fleet", () => {
  it("solo mode says federation is opt-in rather than showing a fleet of one", () => {
    render(<Fleet />);
    expect(screen.getByText(/No peers yet, and nothing is being published/)).toBeInTheDocument();
    // No fleet totals panel: a total over one machine is just that machine.
    expect(screen.queryByText(/Across the fleet/)).not.toBeInTheDocument();
    expect(screen.getByText("this machine")).toBeInTheDocument();
  });

  it("lists peers with their status and last-seen", () => {
    state.fleet = fleetOf(
      [
        selfMachine(),
        { peer: peer(), summary: summary({ machineId: "m2", label: "Build box" }), isSelf: false },
      ],
      2,
    );
    render(<Fleet />);
    expect(screen.getByText("Build box")).toBeInTheDocument();
    expect(screen.getByText("paired")).toBeInTheDocument();
    expect(screen.getByText("http://box.local:7777")).toBeInTheDocument();
  });

  it("regression: totals say how many machines they came from", () => {
    state.fleet = fleetOf(
      [
        selfMachine(),
        { peer: peer(), summary: summary({ machineId: "m2" }), isSelf: false },
        {
          peer: peer({ id: "p2", label: "Quiet", status: "unreachable" }),
          summary: null,
          isSelf: false,
        },
      ],
      2,
    );
    render(<Fleet />);
    // "Spend is fine" computed from two of three machines is wrong on exactly
    // the day a machine goes quiet.
    expect(screen.getByText(/From 2 of 3 machines/)).toBeInTheDocument();
    expect(screen.getByText(/lower bounds/)).toBeInTheDocument();
  });

  it("a complete fleet says so plainly", () => {
    state.fleet = fleetOf(
      [selfMachine(), { peer: peer(), summary: summary({ machineId: "m2" }), isSelf: false }],
      2,
    );
    render(<Fleet />);
    expect(screen.getByText(/From all 2 machines/)).toBeInTheDocument();
  });

  it("regression: a stale peer keeps its figures, marked, rather than blanking", () => {
    state.fleet = fleetOf(
      [
        selfMachine(),
        {
          peer: peer({ status: "stale" }),
          summary: summary({ machineId: "m2", openIssues: 7 }),
          isSelf: false,
        },
      ],
      2,
    );
    render(<Fleet />);
    // "Last known, ten minutes ago" is information; an empty card is not.
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("an unpaired peer is told what is actually wrong", () => {
    state.fleet = fleetOf(
      [
        selfMachine(),
        {
          peer: peer({ status: "unauthorized", error: "the peer did not accept this pairing" }),
          summary: null,
          isSelf: false,
        },
      ],
      1,
    );
    render(<Fleet />);
    expect(screen.getByText("unpaired")).toBeInTheDocument();
    // A mismatched secret and a dead machine want different fixes.
    expect(screen.getByText(/same pairing secret/)).toBeInTheDocument();
  });

  it("minting a secret shows it once, with what to do next", async () => {
    const user = userEvent.setup();
    render(<Fleet />);
    await user.click(screen.getByRole("button", { name: /Mint a pairing secret/ }));
    expect(actions.mintPairing).toHaveBeenCalled();

    state.pairing = { secret: "f".repeat(64), instructions: "Both sides need the same secret." };
    render(<Fleet />);
    expect(screen.getByText("f".repeat(64))).toBeInTheDocument();
    expect(screen.getByText(/shown once/)).toBeInTheDocument();
  });

  it("adding a peer sends the name, url and secret together", async () => {
    const user = userEvent.setup();
    render(<Fleet />);
    await user.type(screen.getByLabelText(/Name/), "Build box");
    await user.type(screen.getByLabelText(/URL/), "http://box.local:7777");
    await user.type(screen.getByLabelText(/Pairing secret/), "a".repeat(64));
    await user.click(screen.getByRole("button", { name: /Add peer/ }));
    expect(actions.addPeer).toHaveBeenCalledWith({
      label: "Build box",
      url: "http://box.local:7777",
      secret: "a".repeat(64),
    });
  });

  it("the add button stays disabled until all three fields are filled", async () => {
    const user = userEvent.setup();
    render(<Fleet />);
    const add = screen.getByRole("button", { name: /Add peer/ });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText(/Name/), "Box");
    expect(add).toBeDisabled();
  });

  it("unpairing names the peer being removed", async () => {
    const user = userEvent.setup();
    state.fleet = fleetOf(
      [selfMachine(), { peer: peer(), summary: summary({ machineId: "m2" }), isSelf: false }],
      2,
    );
    render(<Fleet />);
    await user.click(screen.getByRole("button", { name: /unpair/ }));
    expect(actions.unpair).toHaveBeenCalledWith("p1");
  });

  it("this machine's name is editable, and says it is not the hostname", async () => {
    const user = userEvent.setup();
    render(<Fleet />);
    await user.type(screen.getByLabelText(/Shown to peers/), "Studio");
    await user.click(screen.getByRole("button", { name: /Rename/ }));
    expect(actions.rename).toHaveBeenCalledWith("Studio");
    expect(screen.getByText(/not your hostname/)).toBeInTheDocument();
  });

  it("errors from a pairing action are surfaced without losing the page", () => {
    state.actionError = "that machine is already paired";
    render(<Fleet />);
    expect(screen.getByText(/already paired/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mint a pairing secret/ })).toBeInTheDocument();
  });

  it("says it is reading before the first view lands", () => {
    state.loading = true;
    state.fleet = { ...solo(), machines: [] };
    render(<Fleet />);
    expect(screen.getByText(/Reading the fleet…/)).toBeInTheDocument();
  });
});

describe("Fleet — live region", () => {
  it("announces how much of the fleet is reporting", () => {
    state.fleet = fleetOf(
      [
        selfMachine(),
        { peer: peer(), summary: summary({ machineId: "m2", monitorsDown: 2 }), isSelf: false },
      ],
      2,
    );
    render(<Fleet />);
    expect(screen.getByRole("status")).toHaveTextContent("2 of 2 machines reporting");
  });

  it("regression: solo mode announces nothing, like it renders nothing", () => {
    render(<Fleet />);
    // Parity cuts both ways: a page with no fleet must not narrate one.
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});
