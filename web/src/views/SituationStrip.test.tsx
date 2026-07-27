import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SituationStrip } from "./SituationStrip";
import type { Situation } from "../types";

function situation(over: Partial<Situation> = {}): Situation {
  return {
    generatedAt: "2026-07-07T10:30:00.000Z",
    counts: {
      runsInFlight: 0,
      gatesWaiting: 0,
      failedInstances: 0,
      monitorsDown: 0,
      monitorsFailing: 0,
      openIssues: 0,
      liveAgents: 0,
      anomalies: 0,
    },
    spend: {
      state: "ok",
      today: { spentUsd: 0, limitUsd: null, ratio: null },
      month: { spentUsd: 0, limitUsd: null, ratio: null },
    },
    nextFire: null,
    throughput: Array.from({ length: 24 }, (_, i) => ({
      at: `2026-07-06T${String(i).padStart(2, "0")}:00:00.000Z`,
      succeeded: 0,
      failed: 0,
    })),
    ...over,
  };
}

describe("SituationStrip", () => {
  it("shows a skeleton on first load, not an empty bar", () => {
    render(<SituationStrip situation={null} loading />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText(/loading the board situation/i)).toBeInTheDocument();
  });

  it("renders nothing when there is no situation and nothing in flight", () => {
    const { container } = render(<SituationStrip situation={null} loading={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says so explicitly when nothing needs the user", () => {
    render(<SituationStrip situation={situation()} loading={false} />);
    expect(screen.getByText(/nothing needs you/i)).toBeInTheDocument();
  });

  it("omits a metric with nothing to report rather than showing a grey zero", () => {
    render(
      <SituationStrip
        situation={situation({
          counts: {
            runsInFlight: 0,
            gatesWaiting: 2,
            failedInstances: 0,
            monitorsDown: 0,
            monitorsFailing: 0,
            openIssues: 0,
            liveAgents: 0,
            anomalies: 0,
          },
        })}
        loading={false}
      />,
    );
    expect(screen.getByText("awaiting you")).toBeInTheDocument();
    expect(screen.queryByText("failed")).toBeNull();
    expect(screen.queryByText("open issues")).toBeNull();
    expect(screen.queryByText(/nothing needs you/i)).toBeNull();
  });

  it("links each metric to the view that explains it", () => {
    render(
      <SituationStrip
        situation={situation({
          counts: {
            runsInFlight: 0,
            gatesWaiting: 1,
            failedInstances: 0,
            monitorsDown: 3,
            monitorsFailing: 0,
            openIssues: 2,
            liveAgents: 0,
            anomalies: 0,
          },
        })}
        loading={false}
      />,
    );
    expect(screen.getByRole("link", { name: /awaiting you/i })).toHaveAttribute(
      "href",
      "#/command",
    );
    expect(screen.getByRole("link", { name: /down/i })).toHaveAttribute("href", "#/monitors");
    expect(screen.getByRole("link", { name: /open issues/i })).toHaveAttribute("href", "#/issues");
  });

  it("counts down to the next firing by name", () => {
    const at = new Date(Date.now() + 37 * 60_000).toISOString();
    render(
      <SituationStrip
        situation={situation({
          nextFire: { id: "s1", name: "Dependency audit", kind: "schedule", at },
        })}
        loading={false}
      />,
    );
    expect(screen.getByText("Dependency audit")).toBeInTheDocument();
    expect(screen.getByText(/in 3[67]m/)).toBeInTheDocument();
  });

  it("says 'due now' for a slot that has already passed", () => {
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    render(
      <SituationStrip
        situation={situation({ nextFire: { id: "s1", name: "Late one", kind: "schedule", at } })}
        loading={false}
      />,
    );
    expect(screen.getByText("due now")).toBeInTheDocument();
  });

  it("shows spend against the daily limit when one is set", () => {
    render(
      <SituationStrip
        situation={situation({
          spend: {
            state: "warning",
            today: { spentUsd: 21, limitUsd: 25, ratio: 0.84 },
            month: { spentUsd: 90, limitUsd: 400, ratio: 0.225 },
          },
        })}
        loading={false}
      />,
    );
    expect(screen.getByText("$21.00")).toBeInTheDocument();
    expect(screen.getByText(/of \$25\.00/)).toBeInTheDocument();
  });

  it("shows spend alone, with no bar, when no limit is configured", () => {
    render(
      <SituationStrip
        situation={situation({
          spend: {
            state: "unset",
            today: { spentUsd: 4.2, limitUsd: null, ratio: null },
            month: { spentUsd: 4.2, limitUsd: null, ratio: null },
          },
        })}
        loading={false}
      />,
    );
    expect(screen.getByText("$4.20")).toBeInTheDocument();
    expect(screen.queryByText(/^of /)).toBeNull();
  });

  it("describes the throughput chart for a screen reader", () => {
    const throughput = situation().throughput.map((b, i) =>
      i === 3 ? { ...b, succeeded: 2, failed: 1 } : b,
    );
    render(<SituationStrip situation={situation({ throughput })} loading={false} />);
    expect(
      screen.getByRole("img", { name: "Last 24 hours: 2 succeeded, 1 failed" }),
    ).toBeInTheDocument();
  });
});
