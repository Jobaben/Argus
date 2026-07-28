import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook, act } from "@testing-library/react";
import type { FleetMachine, FleetView, MachineSummary, Peer } from "../types";
import { MachinePicker, PeerBanner, PeerEmpty } from "./MachineFacet";
import { useMachineFacet } from "./useMachineFacet";

const fleetState: { fleet: FleetView } = { fleet: solo() };

vi.mock("../useFleet", () => ({
  useFleet: () => ({ fleet: fleetState.fleet }),
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
    spendTodayUsd: 0,
    spendMonthUsd: 0,
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

// Declarations, not const arrows, throughout these builders: `solo()` runs
// while the module is still evaluating — it initializes `fleetState` — and only
// a hoisted declaration exists that early. `self` is also a DOM global, so the
// name is worth avoiding regardless.
function selfMachine(): FleetMachine {
  return {
    isSelf: true,
    summary: summary(),
    peer: peer({ id: "m1", label: "Laptop", url: "" }),
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
      runsToday: 0,
      failuresToday: 0,
      spendTodayUsd: 0,
      spendMonthUsd: 0,
    },
    soloMode: true,
    generatedAt: "2026-07-20T12:00:00.000Z",
  };
}

function withPeer(over: Partial<FleetMachine> = {}): FleetView {
  return {
    ...solo(),
    soloMode: false,
    machines: [
      selfMachine(),
      {
        peer: peer(),
        summary: summary({ machineId: "m2", label: "Build box" }),
        isSelf: false,
        ...over,
      },
    ],
  };
}

beforeEach(() => {
  fleetState.fleet = solo();
  sessionStorage.clear();
});

describe("useMachineFacet", () => {
  it("regression: solo mode exposes no machines, so every view keeps its old path", () => {
    const { result } = renderHook(() => useMachineFacet());
    // A single-machine install must look exactly as it did before federation.
    expect(result.current.machines).toEqual([]);
    expect(result.current.peer).toBeNull();
    expect(result.current.soloMode).toBe(true);
  });

  it("selecting a peer resolves it, and remembers the choice", () => {
    fleetState.fleet = withPeer();
    const { result } = renderHook(() => useMachineFacet());
    act(() => result.current.select("p1"));
    expect(result.current.peer?.peer.label).toBe("Build box");
    expect(sessionStorage.getItem("argus.machineFacet")).toBe("p1");

    act(() => result.current.select(null));
    expect(result.current.peer).toBeNull();
    expect(sessionStorage.getItem("argus.machineFacet")).toBeNull();
  });

  it("regression: a selection for a peer that was unpaired falls back to this machine", () => {
    fleetState.fleet = withPeer();
    const { result, rerender } = renderHook(() => useMachineFacet());
    act(() => result.current.select("p1"));
    expect(result.current.peer).not.toBeNull();

    // Unpaired in another tab. Showing an empty page for a machine that is gone
    // is worse than quietly showing the one you are on.
    fleetState.fleet = solo();
    rerender();
    expect(result.current.peer).toBeNull();
    expect(result.current.selected).toBeNull();
  });
});

describe("MachinePicker", () => {
  function picker(fleet: FleetView) {
    fleetState.fleet = fleet;
    function Harness() {
      const facet = useMachineFacet();
      return <MachinePicker facet={facet} label="Show from" />;
    }
    return render(<Harness />);
  }

  it("renders nothing at all in solo mode", () => {
    const { container } = picker(solo());
    // Not a disabled control, not a row with one chip: nothing.
    expect(container).toBeEmptyDOMElement();
  });

  it("offers this machine and each peer", async () => {
    const user = userEvent.setup();
    picker(withPeer());
    expect(screen.getByRole("radio", { name: "This machine" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Build box" }));
    expect(screen.getByRole("radio", { name: "Build box" })).toBeChecked();
  });

  it("a peer that is not reporting is still selectable, and says why", () => {
    picker(
      withPeer({
        peer: peer({ status: "unreachable", error: "ECONNREFUSED" }),
        summary: null,
      }),
    );
    // Being able to look at a machine and see "it is down" is the point.
    expect(screen.getByRole("radio", { name: "Build box" })).toHaveAttribute(
      "title",
      expect.stringContaining("ECONNREFUSED"),
    );
  });
});

describe("PeerBanner", () => {
  function banner(fleet: FleetView, select = "p1") {
    fleetState.fleet = fleet;
    function Harness() {
      const facet = useMachineFacet();
      // Select on first render so the banner has a peer to describe.
      if (facet.selected !== select && facet.machines.length > 1) facet.select(select);
      return <PeerBanner facet={facet} />;
    }
    return render(<Harness />);
  }

  it("renders nothing when showing this machine", () => {
    const { container } = banner(solo(), "");
    expect(container).toBeEmptyDOMElement();
  });

  it("names the machine, dates the figures and links out for the detail", () => {
    banner(withPeer());
    expect(screen.getByText("Build box")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open its Argus/ })).toHaveAttribute(
      "href",
      "http://box.local:7777",
    );
  });

  it("regression: a stale peer says its figures are frozen, not merely old", () => {
    banner(withPeer({ peer: peer({ status: "stale" }) }));
    // "As of ten minutes ago" reads as a refresh delay; "stopped answering"
    // reads as what it is.
    expect(screen.getByText(/stopped answering/)).toBeInTheDocument();
  });

  it("a peer with no summary says so instead of dating nothing", () => {
    banner(withPeer({ summary: null, peer: peer({ status: "pending", error: null }) }));
    expect(screen.getByText(/no summary yet/)).toBeInTheDocument();
  });
});

describe("PeerEmpty", () => {
  it("explains that a summary is bounded rather than implying nothing happened", () => {
    render(<PeerEmpty what="open issues" />);
    expect(screen.getByText(/reported no open issues/)).toBeInTheDocument();
    expect(screen.getByText(/not its whole history/)).toBeInTheDocument();
  });
});
