import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Pipelines from "./Pipelines";
import type { OverviewEntry, PipelineDefinition, PipelineInstance, InstanceStatus } from "../types";

class FakeWS {
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

beforeEach(() => vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const p1: PipelineDefinition = {
  id: "p1",
  name: "Nightly",
  phases: [{ id: "a", name: "x", cwd: "/", gated: false, steps: [{ name: "s", prompt: "p" }] }],
  trigger: { kind: "daily", time: "02:00" },
  enabled: true,
  overlapPolicy: "skip",
  lastStartedAt: null,
  createdAt: "",
  updatedAt: "",
};

function instance(status: InstanceStatus): PipelineInstance {
  return {
    id: "i1",
    pipelineId: "p1",
    pipelineName: "Nightly",
    status,
    currentPhaseIndex: 0,
    phases: [
      {
        id: "a",
        name: "x",
        gated: false,
        status: status === "running" ? "running" : "succeeded",
        steps: [{ name: "s", runId: "r1", status: status === "running" ? "running" : "succeeded" }],
        attempt: 1,
        payload: null,
      },
    ],
    trigger: "manual",
    signalToken: "tok",
    createdAt: "",
    updatedAt: "",
    endedAt: null,
  };
}

type AuthStatus = {
  configured: boolean;
  authenticated: boolean;
  username: string | null;
  role: "root" | "member" | null;
};
const ADMIN: AuthStatus = {
  configured: true,
  authenticated: true,
  username: "admin",
  role: "root",
};

/** Routes fetch by URL: /api/overview → overview entries, /api/pipelines → defs,
 *  /api/auth/status → auth (admin by default), anything else → {}. */
/** The server always sends `cost` and `active`; these fixtures describe the
 *  definition/instance shape only, so they are completed here. */
type EntryFixture = Omit<OverviewEntry, "cost" | "active"> & Partial<OverviewEntry>;

function routedFetch(
  overviewFixtures: EntryFixture[],
  pipelines: PipelineDefinition[] = [p1],
  auth: AuthStatus = ADMIN,
) {
  const overview: OverviewEntry[] = overviewFixtures.map((e) => ({
    cost: null,
    active: [],
    ...e,
  }));
  return vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/auth/status")) return Promise.resolve(okJson(auth));
    if (url.includes("/api/overview")) return Promise.resolve(okJson({ overview }));
    if (url.includes("/api/pipelines")) return Promise.resolve(okJson({ pipelines }));
    return Promise.resolve(okJson({}));
  });
}

describe("Pipelines tab", () => {
  it("shows an empty state when there are no pipelines", async () => {
    vi.stubGlobal("fetch", routedFetch([], []));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeTruthy());
  });

  it("opens the form when '+ New pipeline' is clicked", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch([], []));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /new pipeline/i }));
    expect(screen.getByPlaceholderText("Pipeline name")).toBeTruthy();
  });

  it("lists an existing pipeline with its trigger summary", async () => {
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: null }]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText("Nightly")).toBeTruthy());
    expect(screen.getByText(/daily at 02:00/i)).toBeTruthy();
  });

  it("shows a Working badge and a Stop button (no Run now) for a running pipeline", async () => {
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: instance("running") }]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText("Nightly")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: /^stop$/i })).toBeTruthy());
    expect(screen.getByText(/working/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run now/i })).toBeNull();
  });

  it("posts to the abort endpoint when Stop is confirmed", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch([{ definition: p1, latest: instance("running") }]);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^stop$/i })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /^stop$/i }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/instances/i1/abort") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("shows 'Stop all (n)' and aborts every active instance when several overlap", async () => {
    const user = userEvent.setup();
    const pAllow: PipelineDefinition = { ...p1, overlapPolicy: "allow" };
    const i1 = instance("running");
    const i2 = { ...instance("running"), id: "i2" };
    const fetchMock = routedFetch(
      [
        {
          definition: pAllow,
          latest: i2,
          active: [
            { instance: i2, cost: { usd: null, tokens: null } },
            { instance: i1, cost: { usd: null, tokens: null } },
          ],
        },
      ],
      [pAllow],
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Pipelines />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /stop all \(2\)/i })).toBeTruthy(),
    );
    await user.click(screen.getByRole("button", { name: /stop all \(2\)/i }));
    await waitFor(() => {
      for (const id of ["i1", "i2"]) {
        expect(
          fetchMock.mock.calls.some(
            ([url, init]) =>
              String(url).includes(`/api/instances/${id}/abort`) &&
              (init as RequestInit | undefined)?.method === "POST",
          ),
        ).toBe(true);
      }
    });
  });

  it("shows both Run now and Stop for a running pipeline with overlap=allow", async () => {
    const pAllow: PipelineDefinition = { ...p1, overlapPolicy: "allow" };
    vi.stubGlobal(
      "fetch",
      routedFetch([{ definition: pAllow, latest: instance("running") }], [pAllow]),
    );
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^stop$/i })).toBeTruthy());
    expect(screen.getByRole("button", { name: /run now/i })).toBeTruthy();
  });

  it("posts to the start endpoint from Run now while running with overlap=allow", async () => {
    const user = userEvent.setup();
    const pAllow: PipelineDefinition = { ...p1, overlapPolicy: "allow" };
    const fetchMock = routedFetch([{ definition: pAllow, latest: instance("running") }], [pAllow]);
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByRole("button", { name: /run now/i })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /run now/i }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/pipelines/p1/start") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("shows Run now (not Stop) for an idle pipeline", async () => {
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: null }]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByRole("button", { name: /run now/i })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
  });

  it("shows a Stopped badge for an aborted pipeline", async () => {
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: instance("aborted") }]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText(/stopped/i)).toBeTruthy());
  });
});

describe("Pipelines admin gate", () => {
  const anon: AuthStatus = { configured: true, authenticated: false, username: null, role: null };
  const firstRun: AuthStatus = {
    configured: false,
    authenticated: false,
    username: null,
    role: null,
  };

  it("hides edit/run controls and shows the login form when signed out", async () => {
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: null }], [p1], anon));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText("Nightly")).toBeTruthy());
    expect(screen.getByRole("form", { name: /^login$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy();
    for (const name of [/run now/i, /^edit$/i, /^delete$/i, /new pipeline/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("offers first-run account creation when no admin exists yet", async () => {
    vi.stubGlobal("fetch", routedFetch([], [], firstRun));
    render(<Pipelines />);
    await waitFor(() =>
      expect(screen.getByRole("form", { name: /create the root account/i })).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /create & sign in/i })).toBeTruthy();
  });

  it("posts credentials to /api/auth/login on submit", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch([], [], anon);
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy());
    await user.type(screen.getByPlaceholderText("Username"), "usha");
    await user.type(screen.getByPlaceholderText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/auth/login") &&
            (init as RequestInit | undefined)?.method === "POST" &&
            String((init as RequestInit | undefined)?.body).includes('"usha"'),
        ),
      ).toBe(true),
    );
  });

  it("shows a Sign out button with the username when signed in", async () => {
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: null }]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy());
    expect(screen.getByText("admin")).toBeTruthy();
  });

  it("shows where the latest run got to, per phase", async () => {
    // The list used to say "4 phases" and stop, so finding the phase a pipeline
    // was stuck in meant going to the board and locating its card.
    const twoPhase: PipelineDefinition = {
      ...p1,
      phases: [
        { id: "a", name: "Gather", cwd: "/", gated: false, steps: [{ name: "s1", prompt: "p" }] },
        {
          id: "b",
          name: "Verify",
          cwd: "/",
          gated: false,
          steps: [
            { name: "s2", prompt: "p" },
            { name: "s3", prompt: "p" },
          ],
        },
      ],
    };
    const inst: PipelineInstance = {
      ...instance("running"),
      currentPhaseIndex: 1,
      phases: [
        {
          id: "a",
          name: "Gather",
          gated: false,
          status: "succeeded",
          steps: [{ name: "s1", runId: "r1", status: "succeeded" }],
          attempt: 1,
          payload: null,
        },
        {
          id: "b",
          name: "Verify",
          gated: false,
          status: "running",
          steps: [
            { name: "s2", runId: "r2", status: "running" },
            { name: "s3", runId: null, status: "pending" },
          ],
          attempt: 1,
          payload: null,
        },
      ],
    };
    vi.stubGlobal("fetch", routedFetch([{ definition: twoPhase, latest: inst }], [twoPhase]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText("Gather")).toBeTruthy());
    expect(screen.getByText("Verify")).toBeTruthy();
    expect(screen.getByTitle(/2\. Verify — working/)).toBeTruthy();
    expect(screen.getByText(/2 phases, 3 steps/)).toBeTruthy();
  });

  it("says a pipeline has never run instead of showing an empty phase strip", async () => {
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: null }]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText("Nightly")).toBeTruthy());
    expect(screen.getByText(/Never run/)).toBeTruthy();
  });

  it("marks a paused pipeline rather than leaving 'disabled' as loose text", async () => {
    const off = { ...p1, enabled: false };
    vi.stubGlobal("fetch", routedFetch([{ definition: off, latest: null }], [off]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText("paused")).toBeTruthy());
  });

  it("names the failing step and its reason on the card", async () => {
    const failed: PipelineInstance = {
      ...instance("failed"),
      phases: [
        {
          id: "a",
          name: "x",
          gated: false,
          status: "failed",
          steps: [{ name: "s", runId: "r1", status: "failed" }],
          attempt: 1,
          payload: { kind: "failure", reason: "prereq missing: gh\nstack…" },
        },
      ],
    };
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: failed }]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText(/prereq missing: gh/)).toBeTruthy());
  });

  it("teaches what a pipeline is when there are none", async () => {
    vi.stubGlobal("fetch", routedFetch([], []));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeTruthy());
    expect(screen.getByText(/pauses the pipeline there until a/i)).toBeTruthy();
  });

  it("does not pulse a pipeline that is only waiting for a human", async () => {
    // awaiting-approval is stopped, not running; a live pulse there claims work
    // is happening when the pipeline is idle by design.
    const gated: PipelineInstance = {
      ...instance("awaiting-approval"),
      phases: [
        {
          id: "a",
          name: "x",
          gated: true,
          status: "awaiting-approval",
          steps: [{ name: "s", runId: "r1", status: "succeeded" }],
          attempt: 1,
          payload: null,
        },
      ],
    };
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: gated }]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText(/needs approval/i)).toBeTruthy());
    expect(screen.queryByTitle("A run is in flight")).toBeNull();
    // Stopping it is still offered — an awaiting instance can be aborted.
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeTruthy();
  });
});
