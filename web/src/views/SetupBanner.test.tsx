import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PrereqResult } from "../useSetup";
import SetupBanner from "./SetupBanner";

const apply = vi.fn(() => new Promise<void>(() => {})); // never resolves: lets us assert disabled-after-click
const mockSetup: { ok: boolean; prereqs: PrereqResult[]; loading: boolean; error: string | null } =
  {
    ok: true,
    prereqs: [],
    loading: false,
    error: null,
  };

vi.mock("../useSetup", () => ({ useSetup: () => ({ ...mockSetup, apply }) }));

beforeEach(() => {
  apply.mockClear();
  mockSetup.ok = true;
  mockSetup.prereqs = [];
  mockSetup.loading = false;
  mockSetup.error = null;
});

describe("SetupBanner", () => {
  it("renders nothing when everything is ok", () => {
    mockSetup.ok = true;
    const { container } = render(<SetupBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists missing prereqs and shows Apply fixes when a fixable one is missing", () => {
    mockSetup.ok = false;
    mockSetup.prereqs = [
      { id: "signal-stop-hook", label: "Signal Stop hook", status: "missing", fixable: true },
      { id: "claude-cli", label: "Claude CLI on PATH", status: "ok", fixable: false },
    ];
    render(<SetupBanner />);
    expect(screen.getByText("Signal Stop hook")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /apply fixes/i });
    fireEvent.click(btn);
    expect(apply).toHaveBeenCalled();
    expect(btn).toBeDisabled();
  });

  it("hides the button when only report-only prereqs are failing", () => {
    mockSetup.ok = false;
    mockSetup.prereqs = [
      { id: "signal-stop-hook", label: "Signal Stop hook", status: "ok", fixable: true },
      {
        id: "claude-cli",
        label: "Claude CLI on PATH",
        status: "error",
        fixable: false,
        detail: "not found",
      },
    ];
    render(<SetupBanner />);
    expect(screen.getByText(/not found/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply fixes/i })).toBeNull();
  });

  it("marks an outdated fixable prereq and offers Apply fixes", () => {
    mockSetup.ok = false;
    mockSetup.prereqs = [
      {
        id: "signal-stop-hook",
        label: "Signal Stop hook",
        status: "outdated",
        fixable: true,
        detail: "differs from shipped version",
      },
    ];
    render(<SetupBanner />);
    expect(screen.getByText("Signal Stop hook")).toBeInTheDocument();
    expect(screen.getByText(/outdated/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply fixes/i })).toBeInTheDocument();
  });
});
