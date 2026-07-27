import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Search", () => {
  it("says what it searches before you type anything", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<Search />);
    expect(screen.getByText(/Plain-text, case-insensitive/)).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText(/first/)).toBeInTheDocument());
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
      vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)),
    );
    render(<Search />);
    await user.type(screen.getByRole("searchbox"), "boom");
    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeInTheDocument());
  });
});
