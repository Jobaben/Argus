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

/** Routes fetch by URL: /api/overview → overview entries, /api/pipelines → defs, anything else → {}. */
function routedFetch(overview: OverviewEntry[], pipelines: PipelineDefinition[] = [p1]) {
  return vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
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
