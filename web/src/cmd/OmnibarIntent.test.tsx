import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OmnibarIntent } from "./OmnibarIntent";

const PLAN = {
  mode: "plan",
  plan: {
    id: "plan-1",
    status: "ready",
    intent: "pause the nightly triage",
    mutations: [
      {
        kind: "schedule.disable",
        targetId: "s1",
        targetLabel: "Nightly triage",
        value: null,
        before: "enabled",
        after: "disabled",
      },
    ],
    warnings: [],
    summary: "Pause the nightly triage",
    createdAt: "2026-07-20T12:00:00.000Z",
    expiresAt: "2026-07-20T12:05:00.000Z",
  },
  answer: null,
};

function jsonOnce(map: Record<string, unknown>) {
  return vi.fn((path: string, _init?: RequestInit) => {
    void _init;
    const body = map[path];
    if (body === undefined) return Promise.reject(new Error(`unexpected ${path}`));
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("OmnibarIntent", () => {
  it("compiles the sentence and shows the changes without applying anything", async () => {
    const fetchMock = jsonOnce({ "/api/omnibar/plan": PLAN });
    vi.stubGlobal("fetch", fetchMock);
    render(<OmnibarIntent intent="pause the nightly triage" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Nightly triage")).toBeInTheDocument());
    expect(screen.getByText(/enabled/)).toBeInTheDocument();
    expect(screen.getByText("disabled")).toBeInTheDocument();
    // The plan call, and only the plan call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/omnibar/plan");
  });

  it("regression: one planning pass per sentence, however often it re-renders", async () => {
    const fetchMock = jsonOnce({ "/api/omnibar/plan": PLAN });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <OmnibarIntent intent="pause the nightly triage" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText("Nightly triage")).toBeInTheDocument());
    rerender(<OmnibarIntent intent="pause the nightly triage" onClose={vi.fn()} />);
    rerender(<OmnibarIntent intent="pause the nightly triage" onClose={vi.fn()} />);
    // A planning pass costs money and holds the single analysis slot; a render
    // is not a reason to spend another one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("confirming sends only the plan id, never the sentence again", async () => {
    const user = userEvent.setup();
    const fetchMock = jsonOnce({
      "/api/omnibar/plan": PLAN,
      "/api/omnibar/execute": {
        status: "applied",
        applied: PLAN.plan.mutations,
        reversed: [],
        error: null,
        summary: "1 change applied.",
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OmnibarIntent intent="pause the nightly triage" onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Apply 1 change/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Apply 1 change/ }));
    await waitFor(() => expect(screen.getByText("1 change applied.")).toBeInTheDocument());

    const exec = fetchMock.mock.calls.find((c) => c[0] === "/api/omnibar/execute")!;
    expect(JSON.parse(String((exec[1] as RequestInit).body))).toEqual({ planId: "plan-1" });
  });

  it("an empty plan offers nothing to confirm", async () => {
    vi.stubGlobal(
      "fetch",
      jsonOnce({
        "/api/omnibar/plan": {
          mode: "plan",
          answer: null,
          plan: { ...PLAN.plan, status: "empty", mutations: [], summary: "It is already paused." },
        },
      }),
    );
    render(<OmnibarIntent intent="pause the nightly triage" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("It is already paused.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Apply/ })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing to confirm/)).toBeInTheDocument();
  });

  it("warnings are shown next to the plan, without blocking it", async () => {
    vi.stubGlobal(
      "fetch",
      jsonOnce({
        "/api/omnibar/plan": {
          ...PLAN,
          plan: {
            ...PLAN.plan,
            warnings: ['dropped "schedule.disable": no schedule with id ghost'],
          },
        },
      }),
    );
    render(<OmnibarIntent intent="pause everything" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/no schedule with id ghost/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Apply 1 change/ })).toBeInTheDocument();
  });

  it("a question is answered inline, with its links", async () => {
    vi.stubGlobal(
      "fetch",
      jsonOnce({
        "/api/omnibar/plan": {
          mode: "answer",
          plan: null,
          answer: {
            text: "It last ran an hour ago.",
            links: [{ label: "Open", href: "#/schedules" }],
          },
        },
      }),
    );
    render(<OmnibarIntent intent="when did nightly triage last run" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("It last ran an hour ago.")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "#/schedules");
    expect(screen.queryByRole("button", { name: /Apply/ })).not.toBeInTheDocument();
  });

  it("regression: a partial outcome is shown as a failure, not a success", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      jsonOnce({
        "/api/omnibar/plan": PLAN,
        "/api/omnibar/execute": {
          status: "partial",
          applied: PLAN.plan.mutations,
          reversed: [],
          error: "boom",
          summary: '"Weekly audit" failed, and 1 change could not be reversed.',
        },
      }),
    );
    render(<OmnibarIntent intent="pause the nightly triage" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Apply/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Apply/ }));
    // The one outcome that leaves the system part-changed has to read as one.
    const summary = await screen.findByText(/could not be reversed/);
    expect(summary.className).toContain("text-fail");
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("a rejected plan request reports why, and offers nothing to apply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response),
    );
    render(<OmnibarIntent intent="pause the nightly triage" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("sign in to use this"));
    expect(screen.queryByRole("button", { name: /Apply/ })).not.toBeInTheDocument();
  });

  it("regression: a failed confirm leaves the plan on screen, still applicable", async () => {
    const user = userEvent.setup();
    let executeCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        if (path === "/api/omnibar/plan") {
          return Promise.resolve({ ok: true, status: 200, json: async () => PLAN } as Response);
        }
        executeCalls++;
        return Promise.resolve({
          ok: false,
          status: 503,
          json: async () => ({ error: "server is restarting" }),
        } as Response);
      }),
    );
    render(<OmnibarIntent intent="pause the nightly triage" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Apply/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Apply/ }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("server is restarting"),
    );
    // A confirm that never reached the server changed nothing, so the plan is
    // still the plan and the button is still there to press again.
    expect(screen.getByRole("button", { name: /Apply 1 change/ })).toBeInTheDocument();
    expect(executeCalls).toBe(1);
  });

  it("cancelling closes without touching the server again", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const fetchMock = jsonOnce({ "/api/omnibar/plan": PLAN });
    vi.stubGlobal("fetch", fetchMock);
    render(<OmnibarIntent intent="pause the nightly triage" onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onClose).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
