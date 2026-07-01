import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Pipelines from "./Pipelines";

class FakeWS {
  onmessage: ((ev: unknown) => void) | null = null;
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

describe("Pipelines tab", () => {
  it("shows an empty state when there are no pipelines", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ pipelines: [] })));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeTruthy());
  });

  it("opens the form when '+ New pipeline' is clicked", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ pipelines: [] })));
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /new pipeline/i }));
    expect(screen.getByPlaceholderText("Pipeline name")).toBeTruthy();
  });

  it("lists an existing pipeline with its trigger summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okJson({
          pipelines: [
            { id: "p1", name: "Nightly", phases: [{ id: "a", name: "x", cwd: "/", gated: false, steps: [] }],
              trigger: { kind: "daily", time: "02:00" }, enabled: true, overlapPolicy: "skip",
              lastStartedAt: null, createdAt: "", updatedAt: "" },
          ],
        }),
      ),
    );
    render(<Pipelines />);
    await waitFor(() => expect(screen.getByText("Nightly")).toBeTruthy());
    expect(screen.getByText(/daily at 02:00/i)).toBeTruthy();
  });
});
