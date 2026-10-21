import { afterEach, describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/** Every slot in the strip, filled or not, oldest first. */
const slots = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[role=group] > *"),
];

describe("HeartbeatBar", () => {
  it("renders one tick per beat plus placeholder padding up to slots", () => {
    const { container } = render(<HeartbeatBar beats={[beat("a"), beat("b")]} slots={5} />);
    expect(screen.getByRole("group", { name: "Last 2 runs" })).toBeInTheDocument();
    expect(slots(container)).toHaveLength(5);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("colors success, failure, running, and neutral states differently", () => {
    render(
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
    const ticks = screen.getAllByRole("link");
    expect(ticks[0].className).toContain("bg-ok");
    expect(ticks[1].className).toContain("bg-fail");
    expect(ticks[2].className).toContain("bg-run");
    expect(ticks[3].className).toContain("bg-idle");
  });

  it("treats a work-level failed outcome as a failure even when the run succeeded", () => {
    render(<HeartbeatBar slots={1} beats={[beat("x", { outcome: "failed" })]} />);
    expect(screen.getByRole("link").className).toContain("bg-fail");
  });

  it("keeps only the newest beats when over capacity", () => {
    const beats = Array.from({ length: 10 }, (_, i) => beat(`r${i}`));
    const { container } = render(<HeartbeatBar beats={beats} slots={4} />);
    expect(slots(container)).toHaveLength(4);
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "#/run/r6",
      "#/run/r7",
      "#/run/r8",
      "#/run/r9",
    ]);
  });
});

describe("a strip too narrow for every slot", () => {
  afterEach(() => {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  });

  it("shows fewer, wider beats — the newest — rather than hairlines", () => {
    // 120px holds nine 10px beats with their 3px gaps; thirty would be 1px each.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 120,
    });
    const beats = Array.from({ length: 30 }, (_, i) => beat(`r${i}`));
    const { container } = render(<HeartbeatBar beats={beats} />);
    expect(screen.getByRole("group", { name: "Last 9 runs" })).toBeInTheDocument();
    expect(slots(container)).toHaveLength(9);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "#/run/r21");
    expect(links.at(-1)).toHaveAttribute("href", "#/run/r29");
  });
});

describe("a beat is a way into its run", () => {
  it("links to the run, named by its status and when it ran", () => {
    const at = "2026-07-10T08:00:00.000Z";
    render(
      <HeartbeatBar
        slots={3}
        beats={[beat("r1", { at }), beat("r2", { status: "succeeded", outcome: "blocked", at })]}
      />,
    );
    const when = new Date(at).toLocaleString();
    const ok = screen.getByRole("link", { name: `Succeeded, ${when}` });
    expect(ok).toHaveAttribute("href", "#/run/r1");
    // A process that exited cleanly with work that did not get done says both.
    expect(screen.getByRole("link", { name: `Succeeded (blocked), ${when}` })).toHaveAttribute(
      "href",
      "#/run/r2",
    );
  });

  it("leaves the slots no run has filled out of the links", () => {
    const { container } = render(<HeartbeatBar slots={4} beats={[beat("r1"), beat("")]} />);
    expect(slots(container)).toHaveLength(4);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("is one tab stop, entered at the newest run, with the arrows walking back", async () => {
    // Thirty links a card would be thirty tab stops a monitor.
    const user = userEvent.setup();
    render(
      <>
        <HeartbeatBar slots={3} beats={[beat("r1"), beat("r2"), beat("r3")]} />
        <button type="button">After</button>
      </>,
    );
    const [r1, r2, r3] = screen.getAllByRole("link");

    await user.tab();
    expect(r3).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(r2).toHaveFocus();
    await user.keyboard("{Home}");
    expect(r1).toHaveFocus();
    await user.keyboard("{End}");
    expect(r3).toHaveFocus();
    await user.keyboard("{ArrowLeft}");

    // Tab leaves the strip from wherever the arrows left it, rather than
    // stopping again on the newest beat on the way out.
    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    // And coming back lands where the reader was.
    await user.tab({ shift: true });
    expect(r2).toHaveFocus();
  });
});

describe("a run landing", () => {
  it("does not animate the history in on first paint — only an arrival is an arrival", () => {
    const { container } = render(<HeartbeatBar beats={[beat("a"), beat("b")]} slots={5} />);
    const animated = slots(container).filter((s) => s.className.includes("tick-in"));
    expect(animated).toHaveLength(0);
  });

  it("grows the newborn tick from the baseline, and only that one", () => {
    const { container, rerender } = render(<HeartbeatBar beats={[beat("a")]} slots={5} />);
    rerender(<HeartbeatBar beats={[beat("a"), beat("b")]} slots={5} />);
    const animated = slots(container).filter((s) => s.className.includes("tick-in"));
    expect(animated).toHaveLength(1);
    // Scaling from the middle would make the tick look like it floated in; the
    // strip is bottom-aligned and a heartbeat grows off its baseline.
    expect(animated[0].className).toContain("origin-bottom");
  });
});
