import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import type { Chronicle as ChronicleData, ChronicleSpan } from "../types";
import Chronicle from "./Chronicle";

const mockState: { chronicle: ChronicleData; loading: boolean; error: string | null } = {
  chronicle: {
    windowStart: "",
    windowEnd: "",
    groups: [],
    totals: { spans: 0, active: 0, failed: 0, costUsd: null, tokens: null },
  },
  loading: false,
  error: null,
};
const mockHours: number[] = [];

vi.mock("../useChronicle", () => ({
  useChronicle: (hours: number) => {
    mockHours.push(hours);
    return { ...mockState, refresh: vi.fn() };
  },
}));

function span(id: string, over: Partial<ChronicleSpan> = {}): ChronicleSpan {
  return {
    id,
    kind: "run",
    label: `Span ${id}`,
    status: "done",
    startedAt: "2026-07-09T06:00:00.000Z",
    endedAt: "2026-07-09T07:00:00.000Z",
    href: "#/schedules",
    detail: null,
    costUsd: null,
    tokens: null,
    ...over,
  };
}

function withData(): void {
  mockState.chronicle = {
    windowStart: "2026-07-09T00:00:00.000Z",
    windowEnd: "2026-07-09T12:00:00.000Z",
    groups: [
      {
        key: "run:s1",
        label: "Nightly triage",
        kind: "run",
        rows: [[span("a"), span("b", { startedAt: "2026-07-09T08:00:00.000Z", endedAt: null })]],
      },
      {
        key: "session:proj",
        label: "home/user/proj",
        kind: "session",
        rows: [[span("c", { kind: "session", href: null })]],
      },
    ],
    totals: { spans: 3, active: 1, failed: 0, costUsd: 1.25, tokens: 42_000 },
  };
}

describe("Chronicle", () => {
  beforeEach(() => {
    mockHours.length = 0;
    mockState.loading = false;
    mockState.error = null;
    mockState.chronicle = {
      windowStart: "",
      windowEnd: "",
      groups: [],
      totals: { spans: 0, active: 0, failed: 0, costUsd: null, tokens: null },
    };
  });

  it("shows the empty state when the window has no spans", () => {
    render(<Chronicle />);
    expect(screen.getByText(/Nothing happened in this window/)).toBeInTheDocument();
  });

  it("renders group lanes, linked bars, and totals", () => {
    withData();
    render(<Chronicle />);
    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
    expect(screen.getByText("home/user/proj")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Span a, done" })).toHaveAttribute(
      "href",
      "#/schedules",
    );
    // Spanless href renders a plain div, not a link.
    expect(screen.queryByRole("link", { name: "Span c, done" })).not.toBeInTheDocument();
    expect(screen.getByText("$1.25")).toBeInTheDocument();
  });

  it("defaults to 24h and refetches when another window is picked", () => {
    withData();
    render(<Chronicle />);
    expect(mockHours[0]).toBe(24);
    fireEvent.click(screen.getByRole("radio", { name: "6h" }));
    expect(mockHours.at(-1)).toBe(6);
  });

  it("surfaces a fetch error", () => {
    mockState.error = "HTTP 500";
    render(<Chronicle />);
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });
});
