import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { VaultQuartersReport, VaultStatus } from "../types";
import { VaultPanels } from "./VaultPanels";

const state: { status: VaultStatus; report: VaultQuartersReport; loading: boolean } = {
  status: offline(),
  report: { available: false, detail: "", quarters: [] },
  loading: false,
};

vi.mock("../useVault", () => ({
  useVaultStatus: () => ({ data: state.status, loading: false, error: null, refresh: vi.fn() }),
  useVaultQuarters: () => ({
    data: state.report,
    loading: state.loading,
    error: null,
    refresh: vi.fn(),
  }),
}));

function offline(): VaultStatus {
  return {
    available: false,
    reason: "no-sqlite",
    detail: "this Node build has no node:sqlite — the Vault needs Node 22 or newer",
    rows: { runs: 0, events: 0, spendDays: 0, scores: 0 },
    sizeBytes: null,
    oldestRunAt: null,
    newestRunAt: null,
    lastIngestAt: null,
    beyondRetention: 0,
  };
}

function online(over: Partial<VaultStatus> = {}): VaultStatus {
  return {
    available: true,
    reason: null,
    detail: "the Vault is keeping history past what the JSON files retain",
    rows: { runs: 1240, events: 88, spendDays: 200, scores: 310 },
    sizeBytes: 2_400_000,
    oldestRunAt: "2025-08-01T00:00:00.000Z",
    newestRunAt: "2026-07-20T00:00:00.000Z",
    lastIngestAt: "2026-07-20T12:00:00.000Z",
    beyondRetention: 940,
    ...over,
  };
}

const QUARTERS: VaultQuartersReport = {
  available: true,
  detail: "2 quarters of history",
  quarters: [
    {
      key: "2026-Q2",
      label: "2026 Q2",
      startAt: "2026-04-01T00:00:00.000Z",
      endAt: "2026-06-30T00:00:00.000Z",
      runs: 400,
      succeeded: 380,
      failed: 20,
      costUsd: 42.5,
      tokens: 9_000_000,
      medianDurationMs: 90_000,
      medianScore: 7.4,
    },
    {
      key: "2026-Q1",
      label: "2026 Q1",
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-03-31T00:00:00.000Z",
      runs: 100,
      succeeded: 100,
      failed: 0,
      costUsd: 8,
      tokens: 1_000_000,
      medianDurationMs: null,
      medianScore: null,
    },
  ],
};

beforeEach(() => {
  state.status = offline();
  state.report = { available: false, detail: "", quarters: [] };
  state.loading = false;
});

describe("VaultPanels", () => {
  it("teaches what the long view needs when the Vault is unavailable", () => {
    render(<VaultPanels />);
    expect(screen.getByText(/needs the Vault, and it is unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/node:sqlite/)).toBeInTheDocument();
  });

  it("an available but empty Vault says it fills in, not that it is broken", () => {
    state.status = online({ rows: { runs: 0, events: 0, spendDays: 0, scores: 0 } });
    render(<VaultPanels />);
    expect(screen.getByText(/fills in as runs complete/)).toBeInTheDocument();
  });

  it("says it is reading before the first report lands", () => {
    state.loading = true;
    render(<VaultPanels />);
    expect(screen.getByText(/Reading the Vault…/)).toBeInTheDocument();
  });

  it("lists quarters newest first, with cost, tokens and success rate", () => {
    state.status = online();
    state.report = QUARTERS;
    render(<VaultPanels />);
    const rows = screen.getAllByRole("row");
    // Header plus two quarters, newest first.
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("2026 Q2");
    expect(screen.getByText("$42.50")).toBeInTheDocument();
    expect(screen.getByText("95%")).toBeInTheDocument();
    expect(screen.getByText("7.4")).toBeInTheDocument();
  });

  it("regression: an unmeasured quarter shows a dash, never a zero score", () => {
    state.status = online();
    state.report = QUARTERS;
    render(<VaultPanels />);
    const q1 = screen.getAllByRole("row")[2];
    // Q1 has no durations and no scores. Rendering 0.0 would read as "measured,
    // and terrible" rather than "never judged".
    expect(q1).toHaveTextContent("—");
    expect(q1).not.toHaveTextContent("0.0");
  });

  it("reports what the Vault holds beyond JSON retention", () => {
    state.status = online();
    state.report = QUARTERS;
    render(<VaultPanels />);
    expect(screen.getByText(/940 past JSON retention/)).toBeInTheDocument();
    expect(screen.getByText(/2.3 MB/)).toBeInTheDocument();
  });

  it("hides the retention figure when the Vault holds nothing extra", () => {
    state.status = online({ beyondRetention: 0 });
    state.report = QUARTERS;
    render(<VaultPanels />);
    expect(screen.queryByText(/past JSON retention/)).not.toBeInTheDocument();
  });

  it("an unavailable Vault under a populated table still explains itself", () => {
    state.report = QUARTERS;
    render(<VaultPanels />);
    expect(screen.getByText(/Vault unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/newest 50 runs per schedule/)).toBeInTheDocument();
  });
});
