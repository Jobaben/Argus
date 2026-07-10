import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HeartbeatBar } from "./HeartbeatBar";
import type { Heartbeat } from "../types";

function beat(runId: string, over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    runId,
    status: "succeeded",
    outcome: null,
    at: "2026-07-10T08:00:00.000Z",
    durationMs: 1000,
    ...over,
  };
}

describe("HeartbeatBar", () => {
  it("renders one tick per beat plus placeholder padding up to slots", () => {
    const { container } = render(<HeartbeatBar beats={[beat("a"), beat("b")]} slots={5} />);
    const bar = screen.getByRole("img");
    expect(bar.getAttribute("aria-label")).toBe("Last 2 runs");
    expect(container.querySelectorAll("span").length).toBe(5);
  });

  it("colors success, failure, running, and neutral states differently", () => {
    const { container } = render(
      <HeartbeatBar
        slots={4}
        beats={[
          beat("ok"),
          beat("bad", { status: "failed" }),
          beat("live", { status: "running" }),
          beat("meh", { status: "skipped" }),
        ]}
      />,
    );
    const ticks = [...container.querySelectorAll("span")];
    expect(ticks[0].className).toContain("bg-ok");
    expect(ticks[1].className).toContain("bg-fail");
    expect(ticks[2].className).toContain("bg-run");
    expect(ticks[3].className).toContain("bg-idle");
  });

  it("treats a work-level failed outcome as a failure even when the run succeeded", () => {
    const { container } = render(
      <HeartbeatBar slots={1} beats={[beat("x", { outcome: "failed" })]} />,
    );
    expect(container.querySelector("span")!.className).toContain("bg-fail");
  });

  it("keeps only the newest beats when over capacity", () => {
    const beats = Array.from({ length: 10 }, (_, i) => beat(`r${i}`));
    const { container } = render(<HeartbeatBar beats={beats} slots={4} />);
    expect(container.querySelectorAll("span").length).toBe(4);
  });
});
