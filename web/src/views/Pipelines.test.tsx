import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    // The pill's word exactly: the list summary also counts "1 working".
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run now/i })).toBeNull();
  });

  it("posts to the abort endpoint when Stop is confirmed", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch([{ definition: p1, latest: instance("running") }]);
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^stop$/i })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /^stop$/i }));
    expect(
      screen.getByRole("group", { name: "Stop running pipeline “Nightly”?" }),
    ).toHaveAccessibleDescription("In-progress work will be discarded.");
    await user.click(screen.getByRole("button", { name: "Stop pipeline" }));
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

  /** The routed fetch, with PUT refused as `instances-running` until forced. */
  function fetchRefusingEdits() {
    const base = routedFetch([{ definition: p1, latest: instance("running") }]);
    const puts: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== "PUT") return base(input, init);
      puts.push(url);
      if (url.includes("force=1")) return Promise.resolve(okJson(p1));
      return Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({
          error: "1 instance is running",
          code: "instances-running",
          instances: [{ id: "i1", status: "running" }],
        }),
      } as Response);
    });
    return { fetchMock, puts };
  }

  it("asks before saving an edit over a running instance, then saves it with force", async () => {
    const user = userEvent.setup();
    const { fetchMock, puts } = fetchRefusingEdits();
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^edit$/i })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    await user.click(screen.getByRole("button", { name: /save pipeline/i }));
    const question = await screen.findByRole("group", {
      name: "1 instance is running under “Nightly”.",
    });
    expect(question).toHaveAccessibleDescription(/next start/);
    expect(puts).toEqual(["/api/pipelines/p1"]);
    await user.click(screen.getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(puts).toEqual(["/api/pipelines/p1", "/api/pipelines/p1?force=1"]));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /save pipeline/i })).toBeNull(),
    );
  });

  it("keeps the edit open and unsaved when the author declines", async () => {
    const user = userEvent.setup();
    const { fetchMock, puts } = fetchRefusingEdits();
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^edit$/i })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const save = screen.getByRole("button", { name: /save pipeline/i });
    await user.click(save);
    const keep = await screen.findByRole("button", { name: "Keep editing" });
    expect(keep).toHaveFocus();
    await user.click(keep);
    await waitFor(() => expect(screen.queryByText(/1 instance is running/)).toBeNull());
    expect(puts).toEqual(["/api/pipelines/p1"]);
    // Still the form, with focus back on the Save that asked.
    expect(save).toHaveFocus();
    await waitFor(() => expect(save).not.toHaveAttribute("aria-disabled"));
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
    render(<Pipelines />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /stop all \(2\)/i })).toBeTruthy(),
    );
    await user.click(screen.getByRole("button", { name: /stop all \(2\)/i }));
    expect(
      screen.getByRole("group", { name: "Stop all 2 running instances of “Nightly”?" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop 2 instances" }));
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

  /** Whether a DELETE for the pipeline has been sent. */
  const deleted = (fetchMock: ReturnType<typeof routedFetch>) =>
    fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url).includes("/api/pipelines/p1") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );

  it("asks before deleting, and Keep deletes nothing and hands focus back", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch([{ definition: p1, latest: instance("running") }]);
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    const del = await screen.findByRole("button", { name: "Delete Nightly" });
    await user.click(del);
    expect(
      screen.getByRole("group", { name: "Delete pipeline “Nightly”?" }),
    ).toHaveAccessibleDescription(
      "Its running instance will be stopped first, and in-progress work discarded.",
    );
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("group", { name: /delete pipeline/i })).toBeNull();
    expect(del).toHaveFocus();
    expect(deleted(fetchMock)).toBe(false);
  });

  it("deletes once the question is answered with Delete pipeline", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch([{ definition: p1, latest: null }]);
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await user.click(await screen.findByRole("button", { name: "Delete Nightly" }));
    // Nothing is running, so there is no consequence to state.
    expect(screen.getByRole("group", { name: "Delete pipeline “Nightly”?" })).not.toHaveAttribute(
      "aria-describedby",
    );
    expect(deleted(fetchMock)).toBe(false);
    await user.click(screen.getByRole("button", { name: "Delete pipeline" }));
    await waitFor(() => expect(deleted(fetchMock)).toBe(true));
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

  it("lays its footer out as the Scheduler's: run, open, then housekeeping", async () => {
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: null }]));
    render(<Pipelines />);
    const run = await screen.findByRole("button", { name: /run now/i });
    const footer = run.closest("footer") as HTMLElement;
    expect(
      within(footer)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Run now", "Analyze", "Edit", "Disable", "Delete"]);
    // One "Delete" per card on screen; a screen reader hears which card's.
    expect(within(footer).getByRole("button", { name: `Delete ${p1.name}` })).toBeInTheDocument();
  });

  it("names each card by its pipeline, so its repeated buttons say whose they are", async () => {
    const p2: PipelineDefinition = { ...p1, id: "p2", name: "Weekly" };
    vi.stubGlobal(
      "fetch",
      routedFetch(
        [
          { definition: p1, latest: null },
          { definition: p2, latest: null },
        ],
        [p1, p2],
      ),
    );
    render(<Pipelines />);
    const weekly = await screen.findByRole("article", { name: "Weekly" });
    expect(within(weekly).getByRole("button", { name: /run now/i })).toBeInTheDocument();
    expect(within(weekly).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Nightly" })).toBeInTheDocument();
  });

  it("says which count is filtering the list", async () => {
    const user = userEvent.setup();
    const paused: PipelineDefinition = { ...p1, id: "p2", name: "Weekly", enabled: false };
    vi.stubGlobal(
      "fetch",
      routedFetch(
        [
          { definition: p1, latest: null },
          { definition: paused, latest: null },
        ],
        [p1, paused],
      ),
    );
    render(<Pipelines />);
    const filters = await screen.findByRole("group", { name: "Filter pipelines" });
    const all = within(filters).getByRole("button", { name: /^all/i });
    const chip = within(filters).getByRole("button", { name: "1 paused" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("article", { name: "Nightly" })).toBeNull();
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

  it("hides edit/run controls and shows the sign-in form when signed out", async () => {
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: null }], [p1], anon));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText("Nightly")).toBeTruthy());
    expect(screen.getByRole("form", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy();
    for (const name of [/run now/i, /^edit$/i, /^delete$/i, /new pipeline/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("offers first-run account creation when no admin exists yet", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch([], [], firstRun));
    render(<Pipelines />);
    await user.click(await screen.findByRole("button", { name: "Create the root account" }));
    expect(screen.getByRole("form", { name: /create the root account/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /create & sign in/i })).toBeTruthy();
  });

  it("says it once when signed out with nothing to show: the empty state leads into the form", async () => {
    // It used to show the login form *and*, under it, an empty state telling
    // the reader to sign in above.
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch([], [], anon));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeTruthy());
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByText(/sign in above/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Sign in to add one" }));
    // The form takes the empty state's place, with the caret in it.
    expect(screen.getByRole("form", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText(/no pipelines yet/i)).toBeNull();
    expect(screen.getByLabelText("Username")).toHaveFocus();
    // Directly under the page's h1, so the next level down.
    expect(screen.getByRole("heading", { level: 2, name: "Sign in" })).toBeInTheDocument();
  });

  it("puts the empty state back when the form was opened by mistake", async () => {
    // The form replaces the explanation of what a pipeline is, and there was
    // no way back to it short of leaving the page.
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch([], [], anon));
    render(<Pipelines />);
    await user.click(await screen.findByRole("button", { name: "Sign in to add one" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByText(/no pipelines yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to add one" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Sign in to add one" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in to add one" })).toHaveFocus();
  });

  it("posts credentials to /api/auth/login on submit", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch([], [], anon);
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await user.click(await screen.findByRole("button", { name: "Sign in to add one" }));
    // By label: the login panel's fields are labelled now, and their
    // placeholders are examples rather than names.
    await user.type(screen.getByLabelText("Username"), "usha");
    await user.type(screen.getByLabelText(/^password/i), "correct horse");
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
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: null }]));
    render(<Pipelines />);
    // Folded behind the account control, which carries the username, so that
    // Sign out no longer sits beside New pipeline.
    const account = await screen.findByRole("button", { name: "admin" });
    await user.click(account);
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
    expect(screen.getByText("Signed in as")).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText("Prereq missing: gh")).toBeTruthy());
  });

  it("tells a stored `failed: …` reason as the board does, without the verdict", async () => {
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
          payload: {
            kind: "failure",
            reason: "failed: could not reach advisory database (ETIMEDOUT)",
          },
        },
      ],
    };
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: failed }]));
    render(<Pipelines />);
    await waitFor(() =>
      expect(screen.getByText("Could not reach advisory database (ETIMEDOUT)")).toBeTruthy(),
    );
    expect(screen.queryByText(/failed:/i)).toBeNull();
  });

  it("reads a reason that is only the agent's outcome marker as the marker's reason", async () => {
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
          payload: { kind: "failure", reason: "ARGUS_OUTCOME: failed tests are red" },
        },
      ],
    };
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: failed }]));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText("Tests are red")).toBeTruthy());
    expect(screen.queryByText(/ARGUS_OUTCOME/)).toBeNull();
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
    const card = await screen.findByRole("article", { name: "Nightly" });
    await waitFor(() => expect(within(card).getByText("Needs approval")).toBeTruthy());
    expect(screen.queryByTitle("A run is in flight")).toBeNull();
    // Stopping it is still offered — an awaiting instance can be aborted.
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeTruthy();
  });

  it("counts pipelines waiting on a gate in the Command Center's words", async () => {
    const gated = (pipelineId: string, pipelineName: string): PipelineInstance => ({
      ...instance("awaiting-approval"),
      id: `${pipelineId}-i1`,
      pipelineId,
      pipelineName,
      phases: [
        {
          id: "a",
          name: "x",
          gated: true,
          status: "awaiting-approval",
          steps: [{ name: "s", runId: `${pipelineId}-r1`, status: "succeeded" }],
          attempt: 1,
          payload: null,
        },
      ],
    });
    const p2: PipelineDefinition = { ...p1, id: "p2", name: "Weekly" };
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: gated("p1", "Nightly") }]));
    const first = render(<Pipelines />);
    let filters = await screen.findByRole("group", { name: "Filter pipelines" });
    await waitFor(() =>
      expect(within(filters).getByRole("button", { name: "1 needs approval" })).toBeTruthy(),
    );
    first.unmount();

    vi.stubGlobal(
      "fetch",
      routedFetch(
        [
          { definition: p1, latest: gated("p1", "Nightly") },
          { definition: p2, latest: gated("p2", "Weekly") },
        ],
        [p1, p2],
      ),
    );
    render(<Pipelines />);
    filters = await screen.findByRole("group", { name: "Filter pipelines" });
    await waitFor(() =>
      expect(within(filters).getByRole("button", { name: "2 need approval" })).toBeTruthy(),
    );
    expect(screen.queryByText(/awaiting you/i)).toBeNull();
  });
});

describe("Pipelines tab — Analyze", () => {
  it("shows an Analyze button for an admin and opens the tuning drawer for that pipeline", async () => {
    const user = userEvent.setup();
    const base = routedFetch([{ definition: p1, latest: null }]);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/pipelines/p1/tune")) {
        return Promise.resolve(
          init?.method === "POST"
            ? ({
                ok: true,
                status: 202,
                json: async () => ({ report: null, unavailable: null }),
              } as Response)
            : okJson({ report: null, unavailable: null }),
        );
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^analyze$/i })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: /analyze · nightly/i })).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/pipelines/p1/tune") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("hides Analyze when signed out", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([{ definition: p1, latest: null }], [p1], {
        configured: true,
        authenticated: false,
        username: null,
        role: null,
      }),
    );
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText("Nightly")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^analyze$/i })).toBeNull();
  });
});

describe("Pipelines tab — spawn phases", () => {
  /** A parent whose Tasks phase spawns one instance of Nightly per task. */
  const delivery: PipelineDefinition = {
    ...p1,
    id: "delivery",
    name: "Delivery loop",
    trigger: null,
    phases: [
      { id: "plan", name: "Plan", cwd: "/", gated: true, steps: [{ name: "s", prompt: "p" }] },
      {
        id: "tasks",
        name: "Tasks",
        cwd: "/",
        gated: false,
        needs: ["plan"],
        steps: [],
        spawn: { pipelineId: "p1", items: { phase: "plan", path: ["tasks"] }, key: "id" },
      },
    ],
  };
  const spawnedChild = (): PipelineInstance => ({
    ...instance("running"),
    trigger: "spawned",
    parent: { instanceId: "d-1", pipelineId: "delivery", phaseId: "tasks", index: 0, key: "a" },
  });

  it("marks an instance a spawn phase started", async () => {
    vi.stubGlobal("fetch", routedFetch([{ definition: p1, latest: spawnedChild() }]));
    render(<Pipelines />);
    const chip = await screen.findByText("spawned");
    expect(chip.getAttribute("title")).toBe(
      "The latest instance was started by another pipeline's spawn phase",
    );
  });

  it("names the pipelines that spawn this one", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch(
        [
          { definition: p1, latest: null },
          { definition: delivery, latest: null },
        ],
        [p1, delivery],
      ),
    );
    render(<Pipelines />);
    const card = (await screen.findByRole("heading", { name: "Nightly" })).closest("article")!;
    expect(within(card).getByText("spawned by Delivery loop")).toBeInTheDocument();
    const parentCard = screen.getByRole("heading", { name: "Delivery loop" }).closest("article")!;
    expect(within(parentCard).queryByText(/spawned by/)).toBeNull();
  });

  it("says Stop stops the instances a parent spawned, and Delete what it does to parents", async () => {
    const user = userEvent.setup();
    const parentRunning = { ...instance("running"), id: "d-1", pipelineId: "delivery" };
    vi.stubGlobal(
      "fetch",
      routedFetch(
        [
          { definition: p1, latest: null },
          { definition: delivery, latest: parentRunning },
        ],
        [p1, delivery],
      ),
    );
    render(<Pipelines />);
    const parentCard = (await screen.findByRole("heading", { name: "Delivery loop" })).closest(
      "article",
    )!;
    await user.click(await within(parentCard).findByRole("button", { name: "Stop" }));
    expect(
      within(parentCard).getByText(
        "In-progress work will be discarded, and the instances they spawned are stopped too.",
      ),
    ).toBeInTheDocument();
    const card = screen.getByRole("heading", { name: "Nightly" }).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Delete Nightly" }));
    expect(
      within(card).getByText("Pipelines that spawn it stop starting new ones and wait for you."),
    ).toBeInTheDocument();
  });

  function fetchRefusedBy(instances: { id: string; status: InstanceStatus; pipelineId: string }[]) {
    const base = routedFetch([{ definition: p1, latest: null }]);
    const puts: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== "PUT") return base(input, init);
      puts.push(url);
      if (url.includes("force=1")) return Promise.resolve(okJson(p1));
      return Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({ error: "held", code: "instances-running", instances }),
      } as Response);
    });
    return { fetchMock, puts };
  }

  it("asks in a parent's words before saving an edit its children would run", async () => {
    const user = userEvent.setup();
    const { fetchMock, puts } = fetchRefusedBy([
      { id: "d-1", status: "running", pipelineId: "delivery" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await user.click(await screen.findByRole("button", { name: /^edit$/i }));
    await user.click(screen.getByRole("button", { name: /save pipeline/i }));
    const question = await screen.findByRole("group", {
      name: "A live instance of another pipeline will start more instances of “Nightly”.",
    });
    expect(question).toHaveAccessibleDescription("Those would run this edit.");
    await user.click(screen.getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(puts).toEqual(["/api/pipelines/p1", "/api/pipelines/p1?force=1"]));
  });

  it("names both when the pipeline's own instances and a parent hold the edit", async () => {
    const user = userEvent.setup();
    const { fetchMock } = fetchRefusedBy([
      { id: "i1", status: "running", pipelineId: "p1" },
      { id: "d-1", status: "running", pipelineId: "delivery" },
      { id: "d-2", status: "awaiting-approval", pipelineId: "delivery" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await user.click(await screen.findByRole("button", { name: /^edit$/i }));
    await user.click(screen.getByRole("button", { name: /save pipeline/i }));
    const question = await screen.findByRole("group", {
      name: "1 instance is running under “Nightly”.",
    });
    expect(question).toHaveAccessibleDescription(
      /next start\. Live instances of another pipeline will also start more of it/,
    );
  });

  it("counts several live parents", async () => {
    const user = userEvent.setup();
    const { fetchMock } = fetchRefusedBy([
      { id: "d-1", status: "running", pipelineId: "delivery" },
      { id: "d-2", status: "running", pipelineId: "delivery" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<Pipelines />);
    await user.click(await screen.findByRole("button", { name: /^edit$/i }));
    await user.click(screen.getByRole("button", { name: /save pipeline/i }));
    expect(
      await screen.findByRole("group", {
        name: "2 live instances of another pipeline will start more instances of “Nightly”.",
      }),
    ).toBeInTheDocument();
  });
});
