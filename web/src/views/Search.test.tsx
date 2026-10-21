import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Search from "./Search";

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const result = (i: number) => ({
  project: "-home-me-api",
  projectLabel: "/home/me/api",
  sessionId: `sess-${i}`,
  snippet: `the migration broke at step ${i}`,
  type: "assistant",
});

beforeEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "#/search");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Search", () => {
  it("says what it searches before you type anything, and names both indexes", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<Search />);
    expect(screen.getByText(/plain-text and\s+case-insensitive/)).toBeInTheDocument();
    // The page reads two different stores; conflating them in the copy would
    // make "no matches" ambiguous about which one came up empty.
    expect(screen.getByText(/every run and alert Argus has recorded/)).toBeInTheDocument();
  });

  it("reports an exact count when the scan was not capped", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(okJson({ results: [result(1), result(2)], limit: 100, truncated: false })),
      ),
    );
    render(<Search />);
    await user.type(screen.getByRole("searchbox"), "migration");
    await waitFor(() => expect(screen.getByText(/2 matches/)).toBeInTheDocument());
  });

  it("does not present a ceiling as a count", async () => {
    // The scan stops at its cap, so "100 matches" would be read as "there are
    // exactly 100" — which is the one thing the server cannot say.
    const user = userEvent.setup();
    const many = Array.from({ length: 100 }, (_, i) => result(i));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okJson({ results: many, limit: 100, truncated: true }))),
    );
    render(<Search />);
    await user.type(screen.getByRole("searchbox"), "the");
    await waitFor(() => expect(screen.getByText(/First/)).toBeInTheDocument());
    expect(screen.getByText(/narrow the query/)).toBeInTheDocument();
    expect(screen.queryByText(/^100 matches$/)).toBeNull();
  });

  it("explains that matching is literal when nothing matches", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okJson({ results: [], limit: 100, truncated: false }))),
    );
    render(<Search />);
    await user.type(screen.getByRole("searchbox"), "zzzq");
    await waitFor(() => expect(screen.getByText(/No matches for/)).toBeInTheDocument());
    expect(screen.getByText(/literal, not fuzzy/)).toBeInTheDocument();
  });

  it("highlights the matched text in a snippet", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okJson({ results: [result(1)], limit: 100, truncated: false }))),
    );
    render(<Search />);
    await user.type(screen.getByRole("searchbox"), "migration");
    await waitFor(() => expect(screen.getByText(/broke at step/)).toBeInTheDocument());
    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe("migration");
  });

  it("surfaces a failed query", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: "database is locked" }),
        } as Response),
      ),
    );
    render(<Search />);
    await user.type(screen.getByRole("searchbox"), "boom");
    // Both indexes are behind the same failing fetch, so both report it, each
    // under its own heading and with the server's reason rather than a bare
    // status or a claim that the server could not be reached.
    expect(
      await screen.findByText("Couldn't search transcripts: database is locked"),
    ).toBeInTheDocument();
    expect(screen.getByText("Couldn't search the Vault: database is locked")).toBeInTheDocument();
    expect(screen.queryByText(/couldn't reach/i)).toBeNull();
  });

  it("says the server could not be reached when a query gets no answer", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    render(<Search />);
    await user.type(screen.getByRole("searchbox"), "boom");
    await waitFor(() =>
      expect(screen.getAllByText("Couldn't reach the Argus server")).toHaveLength(2),
    );
    expect(screen.queryByText(/failed to fetch/i)).toBeNull();
  });

  it("takes a query handed over in the address, runs it and puts the caret in the field", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(okJson({ results: [result(1)], limit: 100, truncated: false })),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "#/search/ETIMEDOUT%20retries%2Flodash");
    render(<Search />);
    const field = screen.getByRole("searchbox");
    expect(field).toHaveValue("ETIMEDOUT retries/lodash");
    await waitFor(() => expect(field).toHaveFocus());
    // The box owns the query from here; the address is the page's own again.
    expect(window.location.hash).toBe("#/search");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent("ETIMEDOUT retries/lodash")),
        expect.anything(),
      ),
    );
  });

  it("replaces what is in the box when a new query is handed over while it is open", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okJson({ results: [], limit: 100, truncated: false }))),
    );
    render(<Search />);
    const field = screen.getByRole("searchbox");
    await user.type(field, "first");
    // The palette's hand-off link, followed while Search is the open page.
    act(() => {
      window.location.hash = "#/search/second";
    });
    await waitFor(() => expect(field).toHaveValue("second"));
    expect(field).toHaveFocus();
  });
});

describe("Search — run history", () => {
  const vaultHit = (over: Record<string, unknown> = {}) => ({
    kind: "run",
    ref: "02ac2605deadbeef",
    at: new Date().toISOString(),
    title: "Release Train · Implement",
    snippet: "the deploy timed out",
    href: "#/sessions/-home-me-api/sess-1",
    related: false,
    ...over,
  });

  /** Answers the transcript scan and the Vault, each with its own shape. */
  function stubBoth(vault: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.startsWith("/api/vault/")
            ? okJson({ available: true, query: "", limit: 20, truncated: false, ...vault })
            : okJson({ results: [], limit: 100, truncated: false }),
        ),
      ),
    );
  }

  it("prints the Vault's own note in sentence case", async () => {
    const user = userEvent.setup();
    stubBoth({
      detail: "nothing in the Vault matches yet — it indexes runs and alerts, not transcripts",
      hits: [],
      relatedTerms: [],
    });
    render(<Search />);
    await user.type(screen.getByRole("searchbox"), "zxqvbnmq");
    expect(
      await screen.findByText(
        "Nothing in the Vault matches yet — it indexes runs and alerts, not transcripts",
      ),
    ).toBeInTheDocument();
  });

  it("says in words what a Related row is, not only in a tooltip", async () => {
    const user = userEvent.setup();
    stubBoth({
      detail: "0 direct, 1 related",
      hits: [vaultHit({ related: true })],
      relatedTerms: ["timeout"],
    });
    render(<Search />);
    await user.type(screen.getByRole("searchbox"), "deploy");
    expect(await screen.findByText(/Rows marked Related matched one of these/)).toBeInTheDocument();
    // The chip sits above the row's stretched link, so its tooltip can show.
    expect(screen.getByText("Related")).toHaveClass("relative", "z-10");
  });

  it("offers a run's transcript as its own link beside the row's recording link", async () => {
    const user = userEvent.setup();
    stubBoth({ detail: "1 direct", hits: [vaultHit()], relatedTerms: [] });
    render(<Search />);
    await user.type(screen.getByRole("searchbox"), "deploy");
    const transcript = await screen.findByRole("link", { name: "Transcript" });
    const run = screen.getByRole("link", { name: /Release Train · Implement/ });
    expect(transcript).toHaveAttribute("href", "#/sessions/-home-me-api/sess-1");
    expect(run).toHaveAttribute("href", "#/run/02ac2605deadbeef");
    // Not inside the row's link, which would make it no link at all, and above
    // that link's stretched layer, so a press on it reaches it.
    expect(run).not.toContainElement(transcript);
    expect(transcript).toHaveClass("relative", "z-10");
  });
});
