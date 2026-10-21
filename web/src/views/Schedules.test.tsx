import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Run, ScheduleWithNext } from "../types";
import Schedules from "./Schedules";

const mockState: {
  schedules: ScheduleWithNext[];
  runs: Run[];
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} = {
  schedules: [],
  runs: [],
  create: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../useSchedules", () => ({
  useSchedules: () => ({
    schedules: mockState.schedules,
    loading: false,
    error: null,
    create: mockState.create,
    update: mockState.update,
    remove: mockState.remove,
    runNow: vi.fn(),
    cancelRun: vi.fn(),
  }),
}));

vi.mock("../useRuns", () => ({
  useRuns: () => ({ runs: mockState.runs, loading: false, error: null }),
}));

const route: { segments: string[] } = { segments: ["schedules"] };
vi.mock("../useHashRoute", () => ({ useHashRoute: () => route.segments }));

vi.mock("../useLaunch", () => ({
  useLaunch: () => ({
    runs: [],
    loading: false,
    error: null,
    launch: vi.fn().mockResolvedValue(undefined),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../useRuntimes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../useRuntimes")>()),
  useRuntimes: () => ({
    default: "claude",
    runtimes: [
      {
        id: "claude",
        label: "Claude Code",
        available: true,
        models: ["opus", "sonnet", "haiku"],
        reasoningEfforts: [],
      },
      {
        id: "codex",
        label: "Codex",
        available: true,
        models: ["gpt-5.6-sol", "gpt-5.6-terra"],
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    ],
  }),
}));

const schedule = (over: Partial<ScheduleWithNext> = {}): ScheduleWithNext => ({
  id: "s1",
  name: "Nightly audit",
  prompt: "p",
  cwd: "/tmp",
  trigger: { kind: "daily", time: "02:00" },
  enabled: true,
  overlapPolicy: "skip",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  lastRunAt: null,
  lastRunId: null,
  nextRun: null,
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  scheduleId: "s1",
  scheduleName: "Nightly audit",
  prompt: "p",
  cwd: "/tmp",
  status: "succeeded",
  trigger: "scheduled",
  queuedAt: "2026-07-26T11:00:00.000Z",
  startedAt: "2026-07-26T11:00:00.000Z",
  endedAt: "2026-07-26T11:00:30.000Z",
  durationMs: 30_000,
  pid: null,
  exitCode: 0,
  sessionId: null,
  project: null,
  resultSummary: null,
  error: null,
  ...over,
});

describe("Schedules catch-up", () => {
  beforeEach(() => {
    mockState.schedules = [];
    mockState.runs = [];
    mockState.create = vi.fn().mockResolvedValue(undefined);
    mockState.remove = vi.fn().mockResolvedValue(undefined);
  });

  it("submits catchUp: true when the checkbox is ticked", async () => {
    const user = userEvent.setup();
    render(<Schedules />);
    await user.click(screen.getByRole("button", { name: /new schedule/i }));
    await user.type(screen.getByPlaceholderText("Nightly audit"), "Morning briefing");
    await user.type(screen.getByPlaceholderText(/Review yesterday/), "brief me");
    await user.type(screen.getByPlaceholderText("/home/you/project"), "/tmp");
    await user.click(screen.getByRole("checkbox", { name: /catch up/i }));
    await user.click(screen.getByRole("button", { name: /save schedule/i }));

    expect(mockState.create).toHaveBeenCalledTimes(1);
    expect(mockState.create.mock.calls[0][0]).toMatchObject({ catchUp: true });
  });

  it("defaults the checkbox off so catchUp stays falsy", async () => {
    const user = userEvent.setup();
    render(<Schedules />);
    await user.click(screen.getByRole("button", { name: /new schedule/i }));
    await user.type(screen.getByPlaceholderText("Nightly audit"), "Morning briefing");
    await user.type(screen.getByPlaceholderText(/Review yesterday/), "brief me");
    await user.type(screen.getByPlaceholderText("/home/you/project"), "/tmp");
    await user.click(screen.getByRole("button", { name: /save schedule/i }));

    expect(mockState.create.mock.calls[0][0].catchUp).toBeFalsy();
  });

  it("shows a catch-up chip on schedules that opted in", () => {
    mockState.schedules = [schedule({ catchUp: true })];
    render(<Schedules />);
    expect(screen.getByText(/catch-up/i)).toBeTruthy();
  });

  it("submits Codex model and effort selections", async () => {
    const user = userEvent.setup();
    render(<Schedules />);
    await user.click(screen.getByRole("button", { name: /new schedule/i }));
    await user.type(screen.getByPlaceholderText("Nightly audit"), "Codex audit");
    await user.type(screen.getByPlaceholderText(/Review yesterday/), "audit");
    await user.type(screen.getByPlaceholderText("/home/you/project"), "/tmp");
    await user.selectOptions(screen.getByLabelText("Runtime (server default)"), "codex");
    await user.selectOptions(screen.getByLabelText("Model (inherit CLI)"), "gpt-5.6-terra");
    await user.selectOptions(screen.getByLabelText("Effort (inherit CLI)"), "high");
    await user.click(screen.getByRole("button", { name: /save schedule/i }));
    expect(mockState.create.mock.calls[0][0]).toMatchObject({
      runtime: "codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
  });
});

describe("Schedules health", () => {
  beforeEach(() => {
    mockState.schedules = [];
    mockState.runs = [];
  });

  it("humanises an interval instead of printing raw minutes", () => {
    // "every 360 min" is arithmetic left for the reader.
    mockState.schedules = [schedule({ trigger: { kind: "interval", everyMinutes: 360 } })];
    render(<Schedules />);
    expect(screen.getByText("every 6h")).toBeTruthy();
  });

  it("states a failure streak instead of leaving it to be counted", () => {
    mockState.schedules = [schedule()];
    mockState.runs = [
      run({ id: "a", status: "failed", error: "prereq missing: gh\nstack…" }),
      run({ id: "b", status: "failed" }),
      run({ id: "c", status: "failed" }),
    ];
    render(<Schedules />);
    expect(screen.getByText("3 consecutive failures")).toBeTruthy();
    // The reason is on the card, so triage does not require expanding a run.
    expect(screen.getByText("prereq missing: gh")).toBeTruthy();
  });

  it("reads a summary that is only the agent's outcome marker as the marker's reason", () => {
    // The marker is protocol for the scheduler; its reason is the one human
    // line there is, so the streak says it rather than nothing.
    mockState.schedules = [schedule()];
    mockState.runs = [
      run({ id: "a", status: "failed", resultSummary: "ARGUS_OUTCOME: failed tests are red" }),
      run({ id: "b", status: "failed" }),
    ];
    render(<Schedules />);
    expect(screen.getByText("2 consecutive failures")).toBeTruthy();
    expect(screen.getByText("tests are red")).toBeTruthy();
    expect(screen.queryByText(/ARGUS_OUTCOME/)).toBeNull();
  });

  it("lays its footer out as a pipeline card's: run, open, then housekeeping", () => {
    mockState.schedules = [schedule()];
    render(<Schedules />);
    const footer = screen
      .getByRole("button", { name: /run now/i })
      .closest("footer") as HTMLElement;
    expect(
      within(footer)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Run now", "Edit", "Disable", "Delete"]);
    // One "Delete" per card on screen; a screen reader hears which card's.
    expect(
      within(footer).getByRole("button", { name: `Delete ${mockState.schedules[0].name}` }),
    ).toBeInTheDocument();
  });

  it("asks before deleting, and Keep deletes nothing and hands focus back", async () => {
    const user = userEvent.setup();
    mockState.schedules = [schedule()];
    render(<Schedules />);
    const del = screen.getByRole("button", { name: "Delete Nightly audit" });
    await user.click(del);
    expect(screen.getByRole("group", { name: "Delete schedule “Nightly audit”?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("group", { name: /delete schedule/i })).toBeNull();
    expect(del).toHaveFocus();
    expect(mockState.remove).not.toHaveBeenCalled();
  });

  it("deletes once the question is answered with Delete schedule", async () => {
    const user = userEvent.setup();
    mockState.schedules = [schedule()];
    render(<Schedules />);
    await user.click(screen.getByRole("button", { name: "Delete Nightly audit" }));
    await user.click(screen.getByRole("button", { name: "Delete schedule" }));
    expect(mockState.remove).toHaveBeenCalledWith("s1");
  });

  it("does not shout about a single failure a run row already shows", () => {
    mockState.schedules = [schedule()];
    mockState.runs = [run({ status: "failed" }), run({ id: "b", status: "succeeded" })];
    render(<Schedules />);
    expect(screen.queryByText(/consecutive failures/)).toBeNull();
  });

  it("filters to the failing schedules when the failing count is clicked", async () => {
    const user = userEvent.setup();
    mockState.schedules = [
      schedule({ id: "ok", name: "Healthy one" }),
      schedule({ id: "bad", name: "Broken one" }),
    ];
    mockState.runs = [
      run({ id: "1", scheduleId: "ok", status: "succeeded" }),
      run({ id: "2", scheduleId: "bad", status: "failed" }),
    ];
    render(<Schedules />);
    expect(screen.getByText("Healthy one")).toBeTruthy();

    const failing = screen.getByRole("button", { name: /1 failing/i });
    await user.click(failing);
    expect(screen.queryByText("Healthy one")).toBeNull();
    expect(screen.getByText("Broken one")).toBeTruthy();
    expect(failing).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^all/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("names each card by its schedule, so its repeated buttons say whose they are", () => {
    mockState.schedules = [
      schedule({ id: "a", name: "Alpha" }),
      schedule({ id: "b", name: "Beta" }),
    ];
    mockState.runs = [];
    render(<Schedules />);
    const beta = screen.getByRole("article", { name: "Beta" });
    expect(within(beta).getByRole("button", { name: /run now/i })).toBeInTheDocument();
    expect(within(beta).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Alpha" })).toBeInTheDocument();
  });

  it("omits a zero count rather than showing a grey nothing", () => {
    mockState.schedules = [schedule()];
    mockState.runs = [run({ status: "succeeded" })];
    render(<Schedules />);
    expect(screen.queryByRole("button", { name: /failing/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /paused/i })).toBeNull();
  });

  it("says a paused schedule will not fire, next slot or not", () => {
    mockState.schedules = [schedule({ enabled: false, nextRun: "2099-01-01T00:00:00.000Z" })];
    render(<Schedules />);
    expect(screen.getByText(/will not fire/)).toBeTruthy();
    expect(screen.queryByText(/^fires/)).toBeNull();
  });

  it("teaches what a schedule is when there are none", () => {
    render(<Schedules />);
    expect(screen.getByText(/No schedules yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /create your first schedule/i })).toBeTruthy();
  });

  it("tells a schedule with no history how to test it", () => {
    mockState.schedules = [schedule()];
    render(<Schedules />);
    expect(screen.getByText(/No runs recorded yet/)).toBeTruthy();
  });

  it("offers One-off as its second sub-tab, in the hash", () => {
    route.segments = ["schedules"];
    render(<Schedules />);
    expect(screen.getByRole("link", { name: "Schedules" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "One-off" })).toHaveAttribute(
      "href",
      "#/schedules/oneoff",
    );
    expect(screen.queryByRole("button", { name: /Launch/ })).toBeNull();
  });

  it("shows the one-off launch form when the hash names it", () => {
    route.segments = ["schedules", "oneoff"];
    render(<Schedules />);
    expect(screen.getByRole("link", { name: "One-off" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /Launch/ })).toBeInTheDocument();
    expect(screen.getByText(/Nothing launched yet/)).toBeInTheDocument();
    // The Scheduler's own action belongs to the Schedules sub-tab only.
    expect(screen.queryByRole("button", { name: /New schedule/ })).toBeNull();
    route.segments = ["schedules"];
  });
});

describe("Schedules editing", () => {
  beforeEach(() => {
    route.segments = ["schedules"];
    mockState.runs = [];
    mockState.update = vi.fn().mockResolvedValue(undefined);
  });

  it("keeps an open edit through a re-sort of the list", async () => {
    // A wide screen: the cards once sat in two stacks there, and a card that
    // changed stack on a re-sort was remounted — taking the typed edit with it.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("min-width"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    try {
      mockState.schedules = [
        schedule({ id: "a", name: "Alpha" }),
        schedule({ id: "b", name: "Beta" }),
      ];
      const user = userEvent.setup();
      const { rerender } = render(<Schedules />);
      await user.click(screen.getAllByRole("button", { name: "Edit" })[1]);
      const name = screen.getByDisplayValue("Beta");
      await user.clear(name);
      await user.type(name, "Beta, edited");

      // Alpha is paused from elsewhere: it drops to the end, and Beta moves up.
      mockState.schedules = [
        schedule({ id: "a", name: "Alpha", enabled: false }),
        schedule({ id: "b", name: "Beta" }),
      ];
      rerender(<Schedules />);
      expect(screen.getByDisplayValue("Beta, edited")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hands focus back to the card's Edit button when the form closes", async () => {
    mockState.schedules = [
      schedule({ id: "a", name: "Alpha" }),
      schedule({ id: "b", name: "Beta" }),
    ];
    const user = userEvent.setup();
    render(<Schedules />);
    await user.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getAllByRole("button", { name: "Edit" })[1]).toHaveFocus();
  });
});
