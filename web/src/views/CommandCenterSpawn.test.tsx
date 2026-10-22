import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type {
  InstanceParentRef,
  OverviewEntry,
  PhaseProgress,
  PhaseReview,
  PipelineInstance,
  SpawnTask,
} from "../types";
import type { MachineFacetState } from "../fleet/useMachineFacet";
import CommandCenter from "./CommandCenter";

/**
 * A spawn phase on the board (DL-A2): the parent's task tile, each child's
 * parent chip, and deciding at a `children` pause. The mocks are
 * CommandCenter.test.tsx's, with the review read keyed by gate so the drawer
 * can be followed from the parent to a child.
 */

const approve = vi.fn(() => new Promise<Response>(() => {}));
const revise = vi.fn(() => new Promise<Response>(() => {}));
const abort = vi.fn(() => new Promise<Response>(() => {}));
const refresh = vi.fn(() => Promise.resolve());

vi.mock("../useAuth", () => ({
  useAuth: () => ({ status: { authenticated: true }, isAdmin: true }),
}));

// Each gate's review by `<instanceId>/<phaseId>`, and every read the drawer made.
const mockReviews = new Map<string, PhaseReview>();
const reviewRead = vi.fn();
vi.mock("../useGateReview", () => ({
  useGateReview: (instanceId: string | null, phaseId: string | null) => {
    if (!instanceId || !phaseId) return { review: null, loading: false, error: null };
    reviewRead(instanceId, phaseId);
    return {
      review: mockReviews.get(`${instanceId}/${phaseId}`) ?? null,
      loading: false,
      error: null,
    };
  },
  useArtifactContent: () => ({ content: null, loading: false, error: null }),
}));

const mockFacet: MachineFacetState = {
  selected: null,
  select: vi.fn(),
  machines: [],
  peer: null,
  soloMode: true,
};
vi.mock("../fleet/useMachineFacet", () => ({
  useMachineFacet: () => mockFacet,
}));

const mockOverview: { overview: OverviewEntry[] } = { overview: [] };
vi.mock("../useOverview", () => ({
  useOverview: () => ({
    ...mockOverview,
    loading: false,
    error: null,
    refresh,
    approve,
    revise,
    abort,
  }),
}));

vi.mock("../useRunActivity", () => ({
  useRunActivity: () => new Map(),
}));

vi.mock("../useTotals", () => ({
  useTotals: () => ({
    totals: null,
    loading: false,
    error: null,
    reset: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const STAMP = "2026-10-22T09:00:00.000Z";

function phase(id: string, name: string, over: Partial<PhaseProgress> = {}): PhaseProgress {
  return {
    id,
    name,
    gated: false,
    status: "pending",
    steps: [],
    attempt: 0,
    payload: null,
    ...over,
  };
}

function instance(
  id: string,
  pipelineId: string,
  pipelineName: string,
  status: PipelineInstance["status"],
  phases: PhaseProgress[],
  over: Partial<PipelineInstance> = {},
): PipelineInstance {
  return {
    id,
    pipelineId,
    pipelineName,
    status,
    currentPhaseIndex: 0,
    phases,
    trigger: "manual",
    signalToken: "tok",
    createdAt: STAMP,
    updatedAt: STAMP,
    endedAt: null,
    ...over,
  };
}

const definitionBase = {
  trigger: null,
  enabled: true,
  overlapPolicy: "allow" as const,
  lastStartedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
};

/** The parent: Plan, the Tasks spawn phase, Ship. */
function delivery(tasks: SpawnTask[], tasksPhase: Partial<PhaseProgress> = {}): OverviewEntry {
  const latest = instance("p-1", "delivery", "Delivery loop", "running", [
    phase("plan", "Plan", { gated: true, status: "succeeded" }),
    phase("tasks", "Tasks", {
      status: "running",
      needs: ["plan"],
      children: {
        pipelineId: "child",
        source: { phaseId: "plan", attempt: 0 },
        maxParallel: 1,
        tasks,
      },
      ...tasksPhase,
    }),
    phase("ship", "Ship", { needs: ["tasks"] }),
  ]);
  if (tasksPhase.status === "awaiting-approval") latest.status = "awaiting-approval";
  return {
    definition: {
      ...definitionBase,
      id: "delivery",
      name: "Delivery loop",
      phases: [
        { id: "plan", name: "Plan", cwd: "/", gated: true, steps: [{ name: "s", prompt: "x" }] },
        {
          id: "tasks",
          name: "Tasks",
          cwd: "/",
          gated: false,
          needs: ["plan"],
          steps: [],
          spawn: { pipelineId: "child", items: { phase: "plan", path: ["tasks"] }, key: "id" },
        },
        {
          id: "ship",
          name: "Ship",
          cwd: "/",
          gated: false,
          needs: ["tasks"],
          steps: [{ name: "s", prompt: "x" }],
        },
      ],
    },
    latest,
    cost: null,
    active: [],
  };
}

const parentRef = (key: string, index: number): InstanceParentRef => ({
  instanceId: "p-1",
  pipelineId: "delivery",
  phaseId: "tasks",
  index,
  key,
});

/** The task pipeline's live children: `a` builds, `b` waits at its PR gate. */
function taskLoop(): OverviewEntry {
  const a = instance(
    "c-a",
    "child",
    "Task loop",
    "running",
    [
      phase("build", "Build", {
        status: "running",
        steps: [{ name: "build", runId: "r-a", status: "running" }],
      }),
      phase("pr", "PR", { gated: true }),
    ],
    { trigger: "spawned", parent: parentRef("a", 0) },
  );
  const b = instance(
    "c-b",
    "child",
    "Task loop",
    "awaiting-approval",
    [
      phase("build", "Build", { status: "succeeded" }),
      phase("pr", "PR", { gated: true, status: "awaiting-approval", pause: "gate" }),
    ],
    { trigger: "spawned", parent: parentRef("b", 1) },
  );
  return {
    definition: {
      ...definitionBase,
      id: "child",
      name: "Task loop",
      phases: [
        { id: "build", name: "Build", cwd: "/", gated: false, steps: [{ name: "s", prompt: "x" }] },
        { id: "pr", name: "PR", cwd: "/", gated: true, steps: [{ name: "s", prompt: "x" }] },
      ],
    },
    latest: b,
    cost: null,
    active: [
      { instance: b, cost: { usd: 0, tokens: 0 } },
      { instance: a, cost: { usd: 0, tokens: 0 } },
    ],
  };
}

const running: SpawnTask[] = [
  { key: "a", title: "Add the schema", state: "running", instanceId: "c-a" },
  {
    key: "b",
    title: "Add sign-in",
    state: "awaiting-approval",
    instanceId: "c-b",
    waitingPhaseId: "pr",
  },
  { key: "c", title: "Write the docs", state: "pending", dependsOn: [0] },
];

function review(over: Partial<PhaseReview>): PhaseReview {
  return {
    instanceId: "c-b",
    phaseId: "pr",
    phaseName: "PR",
    pipelineName: "Task loop",
    status: "awaiting-approval",
    attempt: 0,
    canApprove: true,
    payload: { summary: "Opened the pull request." },
    artifactDir: null,
    artifacts: [],
    ...over,
  };
}

beforeEach(() => {
  approve.mockClear();
  revise.mockClear();
  abort.mockClear();
  reviewRead.mockClear();
  mockReviews.clear();
  mockReviews.set("c-b/pr", review({}));
  mockOverview.overview = [delivery(running), taskLoop()];
});

const parentSection = () => document.getElementById("instance-p-1")!;

describe("CommandCenter: spawn phases", () => {
  it("draws the spawn phase's glyph, and its tasks in place of step tiles", async () => {
    render(<CommandCenter />);
    const section = parentSection();
    expect(within(section).getByTestId("spawn-summary").textContent).toBe("0/3");
    const tile = await within(section).findByTestId("spawn-children");
    expect(within(section).queryByTestId("phase-grid")).toBeNull();
    expect(within(tile).getAllByTestId("spawn-task")).toHaveLength(3);
    expect(within(tile).getByText("Waits for a")).toBeInTheDocument();
  });

  it("leads with the waiting task, whose Review opens the child's gate", async () => {
    render(<CommandCenter />);
    const waiting = await screen.findByTestId("spawn-waiting");
    fireEvent.click(within(waiting).getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog");
    expect(reviewRead).toHaveBeenCalledWith("c-b", "pr");
    expect(within(dialog).getByText(/Task loop \[b\]/)).toBeInTheDocument();
  });

  it("starts each child's section with its parent chip, which shows the parent", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<CommandCenter />);
    const chip = await screen.findByRole("button", { name: /Task a · Delivery loop/ });
    expect(
      await screen.findByRole("button", { name: /Task b · Delivery loop/ }),
    ).toBeInTheDocument();
    expect(document.getElementById("instance-c-a")!.contains(chip)).toBe(true);
    fireEvent.click(chip);
    expect(scroll.mock.contexts.at(-1)).toBe(parentSection());
    expect(document.activeElement).toBe(parentSection());
    scroll.mockRestore();
  });

  it("names a child after its task in Needs you", () => {
    render(<CommandCenter />);
    const needsYou = screen.getByRole("region", { name: "Needs you" });
    expect(within(needsYou).getByText("Task loop [b] · PR")).toBeInTheDocument();
  });

  it("decides a children pause in the parent's drawer: accept, re-run or stop", async () => {
    const halted: SpawnTask[] = [
      { key: "a", state: "succeeded", instanceId: "c-a" },
      { key: "b", state: "failed", instanceId: "c-b", reason: "tests failed" },
      { key: "c", state: "blocked", dependsOn: [1] },
    ];
    mockOverview.overview = [
      delivery(halted, { status: "awaiting-approval", pause: "children" }),
      taskLoop(),
    ];
    mockReviews.set(
      "p-1/tasks",
      review({
        instanceId: "p-1",
        phaseId: "tasks",
        phaseName: "Tasks",
        pipelineName: "Delivery loop",
        payload: null,
        children: {
          pipelineId: "child",
          source: { phaseId: "plan", attempt: 0 },
          maxParallel: 1,
          tasks: halted,
          notSucceeded: ["b", "c"],
        },
      }),
    );
    render(<CommandCenter />);
    const needsYou = screen.getByRole("region", { name: "Needs you" });
    expect(within(needsYou).getByText("Delivery loop · Tasks")).toBeInTheDocument();
    expect(within(needsYou).getByText("Tasks need a decision")).toBeInTheDocument();
    const halt = await screen.findByTestId("spawn-halted");
    expect(halt).toHaveTextContent("2 of 3 tasks did not succeed");
    // The tile leads the parent's panel; the generic gate line is the child's own.
    expect(within(parentSection()).queryByText(/Paused for your approval/)).toBeNull();
    fireEvent.click(within(halt).getByTestId("gate-opener"));
    const dialog = await screen.findByRole("dialog");
    expect(reviewRead).toHaveBeenCalledWith("p-1", "tasks");
    expect(within(dialog).getByRole("button", { name: "Accept the rest" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Re-run the rest" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop instance" }));
    expect(abort).toHaveBeenCalledWith("p-1");
  });

  it("offers Review on a failed task only while its parent still waits for it", async () => {
    const halted: SpawnTask[] = [
      { key: "a", state: "succeeded", instanceId: "c-a" },
      { key: "b", state: "failed", instanceId: "c-b", reason: "tests failed" },
    ];
    // b's child failed at Build, and is its pipeline's latest instance.
    const failedChild = instance(
      "c-b",
      "child",
      "Task loop",
      "failed",
      [phase("build", "Build", { status: "failed" }), phase("pr", "PR", { gated: true })],
      { trigger: "spawned", parent: parentRef("b", 1) },
    );
    const taskLoopFailed: OverviewEntry = { ...taskLoop(), latest: failedChild, active: [] };
    const taskB = async () =>
      (await within(parentSection()).findAllByTestId("spawn-task")).find(
        (li) => li.dataset.state === "failed",
      )!;

    mockOverview.overview = [
      delivery(halted, { status: "awaiting-approval", pause: "children" }),
      taskLoopFailed,
    ];
    const { unmount } = render(<CommandCenter />);
    expect(within(await taskB()).getByRole("button", { name: "Review" })).toBeInTheDocument();
    unmount();

    // Stopped: the parent no longer waits, and revising b's child would be refused.
    const stopped = delivery(halted, { status: "aborted" });
    stopped.latest!.status = "aborted";
    mockOverview.overview = [stopped, taskLoopFailed];
    render(<CommandCenter />);
    expect(within(await taskB()).queryByRole("button")).toBeNull();
  });
});
