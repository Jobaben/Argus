import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { H1Agreement, H1ReportResponse, H2Usage } from "@argus/contracts";
import { DecisionH1Section } from "./DecisionH1";

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
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as Response;
}

function mockFetch(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const handler = handlers[path];
    if (!handler) throw new Error(`unmocked fetch: ${path}`);
    return handler(init);
  });
}

const STATEMENT = "Behavioural agreement is not correctness and cannot justify skipping review.";

const usage: H2Usage = {
  latencyMs: { n: 8, p50: 1200, p95: 3400, max: 4100 },
  costUsd: { total: 0.0412, meanKnown: 0.0051, known: 8, unknown: 0 },
  tokens: { total: 9600, meanKnown: 1200, known: 8, unknown: 0 },
  snapshotBytes: { n: 8, p50: 2048, p95: 4096, max: 5120 },
};

const NONE = { k: 0, n: 0, value: null, ci95: null };

function agreement(over: Partial<H1Agreement> = {}): H1Agreement {
  return {
    columns: ["sent-back", "approve", "abstain"],
    sentBackColumn: "sent-back",
    approveColumn: "approve",
    decidedColumns: ["sent-back", "approve"],
    confusion: {
      rows: ["sent-back", "not-sent-back"],
      columns: ["sent-back", "approve", "abstain"],
      counts: [
        [5, 2, 1],
        [3, 9, 0],
      ],
    },
    scored: 20,
    answered: 19,
    coverage: { k: 19, n: 20, value: 0.95, ci95: [0.764, 0.991] },
    agreementAnswered: { k: 14, n: 19, value: 0.737, ci95: [0.512, 0.882] },
    agreementEndToEnd: { k: 14, n: 20, value: 0.7, ci95: null },
    falseClose: { k: 2, n: 7, value: 0.286, ci95: [0.082, 0.641] },
    falseEscalation: NONE,
    kappa: { status: "unmeasured", reason: "fewer than 30 answered items" },
    ...over,
  };
}

const fixture: H1ReportResponse = {
  collection: {
    enabled: false,
    reasons: ["ARGUS_H1_COLLECT is not set"],
    settings: {
      rate: 0.1,
      seed: "seed-h1",
      models: ["haiku", null],
      maxCallsPer24h: 50,
      maxOwnCallsPer24h: 20,
      minCallIntervalMs: 120_000,
      maxUsdPer24h: 3,
    },
    watcher: { state: "paused", detail: "daily cap reached", until: "2026-09-30T00:00:00.000Z" },
  },
  report: {
    report: { id: "decision-h1-report", version: 1 },
    asOf: { seq: 99, at: "2026-09-29T12:00:00.000Z" },
    statement: STATEMENT,
    collection: {
      start: "2026-09-20T08:00:00.000Z",
      configs: [
        {
          digest: "0123456789abcdef0123",
          firstAt: "2026-09-20T08:00:00.000Z",
          seed: "seed-h1",
          rate: 0.1,
          arms: [
            { requestedModel: "haiku", adapterVersion: 2 },
            { requestedModel: null, adapterVersion: 2 },
          ],
          limits: {
            maxCallsPer24h: 50,
            maxOwnCallsPer24h: 20,
            minCallIntervalMs: 120_000,
            maxUsdPer24h: 3,
            maxTriesPerItem: 3,
            retryAfterMs: 60_000,
          },
        },
      ],
    },
    definitions: [
      {
        kind: "question",
        id: "gate.operator-action",
        version: 1,
        digest: "d1",
        status: "registered",
      },
    ],
    gates: { excluded: { "no-review-state": 3 } },
    census: [
      {
        population: "manual",
        captured: 40,
        sampled: 12,
        notSampled: 28,
        pending: 6,
        resolved: 30,
        windowClosed: 4,
        labeled: { sentBack: 8, notSentBack: 12, approve: 12, revise: 5, abort: 3 },
        unlabeled: { "attempt-superseded": 2 },
        state: { held: 18, changed: 2, unobserved: 0 },
        principals: { session: 14, "api-token": 6 },
        notCalled: { "budget-exhausted": 4 },
      },
      {
        population: "auto-approve-declared",
        captured: 5,
        sampled: 1,
        notSampled: 4,
        pending: 1,
        resolved: 3,
        windowClosed: 0,
        labeled: { sentBack: 0, notSentBack: 3, approve: 3, revise: 0, abort: 0 },
        unlabeled: {},
        state: { held: 3, changed: 0, unobserved: 0 },
        principals: {},
        notCalled: {},
      },
    ],
    pending: { total: 7, byPopulation: { manual: 6, "auto-approve-declared": 1 } },
    deterministic: [
      {
        population: "manual",
        definition: { id: "gate.rules", version: 2, digest: "r1" },
        scored: 20,
        agreement: agreement(),
      },
    ],
    verdict: [
      {
        population: "manual",
        definition: { id: "gate.verdict-rating", version: 1, digest: "v1" },
        scored: 18,
        agreement: agreement({ scored: 18 }),
        auroc: {
          status: "measured",
          value: { value: 0.71, ci95: [0.52, 0.86], sentBack: 7, notSentBack: 11 },
        },
      },
      {
        population: "auto-approve-declared",
        definition: { id: "gate.verdict-rating", version: 1, digest: "v1" },
        scored: 0,
        agreement: agreement({ scored: 0 }),
        auroc: { status: "unmeasured", reason: "no sent-back gates in the scoring set" },
      },
    ],
    models: [
      {
        population: "manual",
        question: {
          id: "gate.operator-action",
          version: 1,
          digest: "d1",
          definition: "registered",
        },
        projection: { id: "gate.projection", version: 1, digest: "p1" },
        provider: {
          provider: "claude-cli",
          requestedModel: null,
          reportedModel: null,
          adapterVersion: 2,
          elicitation: "verbalized",
        },
        attempts: {
          answered: 7,
          abstained: 1,
          "provider-failed": 0,
          refused: 2,
          "missing-input": 0,
          "construction-error": 0,
          unrecorded: 0,
          "unknown-outcome": 0,
          unresolved: 0,
        },
        assessed: 8,
        answered: 7,
        abstained: 1,
        failed: 0,
        refusals: { "budget-exhausted": 2 },
        excluded: { "state-changed": 1 },
        agreement: agreement(),
        brier: { status: "unmeasured", reason: "n = 7 < 30" },
        reliability: {
          minBucket: 30,
          buckets: [
            {
              lower: 0.2,
              upper: 0.4,
              n: 40,
              status: "measured",
              meanPredicted: 0.31,
              observedRate: 0.25,
            },
            {
              lower: 0.4,
              upper: 0.6,
              n: 5,
              status: "unmeasured",
              meanPredicted: null,
              observedRate: null,
            },
          ],
        },
        ece: { status: "unmeasured", reason: "n = 5 < 30" },
        paired: {
          deterministic: agreement({
            agreementAnswered: { k: 6, n: 8, value: 0.75, ci95: null },
          }),
          verdict: agreement({
            agreementAnswered: { k: 1, n: 8, value: 0.125, ci95: null },
          }),
        },
        usage,
      },
      {
        population: "auto-approve-declared",
        question: {
          id: "gate.operator-action",
          version: 1,
          digest: "d1",
          definition: "registered",
        },
        projection: { id: "gate.projection", version: 1, digest: "p1" },
        provider: {
          provider: "claude-cli",
          requestedModel: "haiku",
          reportedModel: "claude-haiku-x",
          adapterVersion: 2,
          elicitation: "verbalized",
        },
        attempts: {
          answered: 4,
          abstained: 0,
          "provider-failed": 0,
          refused: 0,
          "missing-input": 0,
          "construction-error": 0,
          unrecorded: 0,
          "unknown-outcome": 0,
          unresolved: 0,
        },
        assessed: 4,
        answered: 4,
        abstained: 0,
        failed: 0,
        refusals: {},
        excluded: {},
        agreement: agreement({ scored: 4, answered: 4 }),
        brier: { status: "measured", value: { value: 0.214, n: 40 } },
        reliability: { minBucket: 30, buckets: [] },
        ece: { status: "measured", value: { value: 0.061, n: 40 } },
        paired: { deterministic: agreement(), verdict: agreement() },
        usage,
      },
    ],
    spend: { attempts: 15, spent: 11, usdTotal: 0.0412, usdUnknown: 2 },
    methods: { proportions: "Wilson 95% intervals.", reference: "Revise and abort are sent back." },
    integrity: {
      history: "incomplete",
      ledger: [{ kind: "torn-line", line: 12, attemptId: null, detail: "line 12 is truncated" }],
      journal: {
        gaps: 1,
        notices: [{ kind: "gap", segment: "seg-2", line: null, detail: "missing segment" }],
      },
      findings: [
        {
          kind: "orphan-attempt",
          line: 17,
          attemptId: "HA-9",
          detail: "attempt has no result record",
        },
      ],
    },
  },
};

const emptyReport: H1ReportResponse = {
  collection: {
    enabled: true,
    reasons: [],
    settings: null,
    watcher: { state: "inactive", detail: null, until: null },
  },
  report: {
    ...fixture.report,
    asOf: { seq: 0, at: null },
    collection: { start: null, configs: [] },
    definitions: [],
    gates: { excluded: {} },
    census: [],
    pending: { total: 0, byPopulation: { manual: 0, "auto-approve-declared": 0 } },
    deterministic: [],
    verdict: [],
    models: [],
    methods: {},
    integrity: { history: "complete", ledger: [], journal: { gaps: 0, notices: [] }, findings: [] },
  },
};

/** The value shown next to a label in a facts list. */
const fact = (label: string): string | null | undefined =>
  screen.getByText(label).nextSibling?.textContent;

const renderLoaded = async (body: H1ReportResponse = fixture) => {
  const spy = mockFetch({ "/api/decisions/h1": () => okJson(body) });
  render(<DecisionH1Section />);
  await screen.findByRole("note");
  return spy;
};

describe("DecisionH1Section", () => {
  it("always shows the statement verbatim with the shadow-only note", async () => {
    await renderLoaded();
    expect(screen.getByRole("heading", { name: "H1 — gate operator action" })).toBeTruthy();
    const note = screen.getByRole("note");
    expect(within(note).getByText(STATEMENT)).toBeTruthy();
    expect(note.textContent).toContain(
      "H1 is a shadow experiment: no gate, badge, ordering or approval reads these predictions, and gates still waiting on an operator are shown only as counts.",
    );
  });

  it("shows the statement even when nothing has been collected", async () => {
    await renderLoaded(emptyReport);
    expect(within(screen.getByRole("note")).getByText(STATEMENT)).toBeTruthy();
    expect(screen.getByText("Collection enabled")).toBeTruthy();
    expect(screen.getByText("No settings reported.")).toBeTruthy();
    expect(screen.getByText("No H1 collection config recorded.")).toBeTruthy();
    expect(screen.getByText("No H1 census recorded.")).toBeTruthy();
    expect(screen.getByText("No deterministic baseline rows.")).toBeTruthy();
    expect(screen.getByText("No verdict baseline rows.")).toBeTruthy();
    expect(screen.getByText("No settled model assessments yet.")).toBeTruthy();
    expect(screen.getAllByText("No findings recorded.").length).toBe(3);
    expect(screen.getByText(/Gate pauses seen and not captured: none/)).toBeTruthy();
    expect(screen.getByText(/H1 report as of ledger record 0 \(no records\)/)).toBeTruthy();
  });

  it("renders the collection status, settings and configs", async () => {
    await renderLoaded();
    expect(screen.getByText("Collection off")).toBeTruthy();
    expect(screen.getByText("ARGUS_H1_COLLECT is not set")).toBeTruthy();
    expect(
      screen.getByText("paused — daily cap reached (until 2026-09-30T00:00:00.000Z)"),
    ).toBeTruthy();
    expect(fact("Sampling rate")).toBe("10%");
    expect(fact("Models")).toBe("haiku · runner default");
    expect(screen.getAllByText("haiku · runner default")).toHaveLength(2);
    expect(fact("Combined max calls per 24h")).toBe("50");
    expect(fact("H1 own share per 24h")).toBe("20");
    expect(fact("Min interval between calls")).toBe("2 min");
    expect(fact("Max spend per 24h")).toBe("$3");
    expect(fact("Seed")).toBe("seed-h1");
    expect(fact("Recorded sampling rate")).toBe("10%");
    expect(screen.getByText("0123456789ab")).toBeTruthy();
  });

  it("renders pending counts by population, counted and not shown", async () => {
    await renderLoaded();
    const pending = screen.getByText("Pending gates (total)").closest("dl") as HTMLElement;
    expect(within(pending).getByText("7")).toBeTruthy();
    expect(within(pending).getByText("Manual gates").nextSibling?.textContent).toBe("6");
    expect(within(pending).getByText("Gates declaring autoApprove").nextSibling?.textContent).toBe(
      "1",
    );
    expect(screen.getByText(/Pending gates are counted, not shown/)).toBeTruthy();
  });

  it("renders a census row with counts, reasons and the principal caption", async () => {
    await renderLoaded();
    const census = screen
      .getByRole("heading", { name: "Census", level: 2 })
      .closest("section") as HTMLElement;
    const card = within(census).getAllByRole("heading", { level: 3 })[0]
      .parentElement as HTMLElement;
    const row = (label: string) => within(card).getByText(label).nextSibling?.textContent;
    expect(row("Captured")).toBe("40");
    expect(row("Sampled")).toBe("12");
    expect(row("Not sampled")).toBe("28");
    expect(row("Resolved")).toBe("30");
    expect(row("Window closed")).toBe("4");
    expect(row("Labeled: sent back")).toBe("8");
    expect(row("Labeled: revise")).toBe("5");
    expect(row("Unlabeled reasons")).toBe("attempt-superseded: 2");
    expect(row("Review state")).toBe("held 18 · changed 2 · unobserved 0");
    expect(row("Principals")).toBe("session: 14 · api-token: 6");
    expect(row("Not called (reasons)")).toBe("budget-exhausted: 4");
    expect(
      screen.getAllByText(
        "A session principal is an authenticated account, not proof that a person acted.",
      ).length,
    ).toBe(2);
    expect(screen.getByText(/Gate pauses seen and not captured: no-review-state: 3/)).toBeTruthy();
  });

  it("renders the confusion matrix and agreement metrics", async () => {
    await renderLoaded();
    const matrix = screen.getAllByRole("table", {
      name: "Confusion matrix for gate.rules@2 (Manual gates)",
    })[0];
    expect(within(matrix).getByRole("columnheader", { name: "abstain" })).toBeTruthy();
    const sentBack = within(matrix).getByRole("rowheader", { name: "sent back" }).closest("tr");
    expect(
      within(sentBack as HTMLElement)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["5", "2", "1"]);
    const notSentBack = within(matrix)
      .getByRole("rowheader", { name: "not sent back" })
      .closest("tr");
    expect(
      within(notSentBack as HTMLElement)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["3", "9", "0"]);

    expect(screen.getAllByText("Agreement with operator (answered)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Agreement with operator (end-to-end)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("73.7% (14/19, 95% CI 51.2–88.2%)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("70.0% (14/20)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("95.0% (19/20, 95% CI 76.4–99.1%)").length).toBeGreaterThan(0);
  });

  it("formats false close and false escalation, including an empty denominator", async () => {
    await renderLoaded();
    expect(
      screen.getAllByText("False close (predicts approve | sent back)").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("False escalation (predicts sent back | approved)").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("28.6% (2/7, 95% CI 8.2–64.1%)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("— (n = 0)").length).toBeGreaterThan(0);
  });

  it("renders the baselines with their captions, AUROC and unmeasured reasons", async () => {
    await renderLoaded();
    expect(screen.getByText("gate.rules@2")).toBeTruthy();
    expect(screen.getByText("A rule result, not a probability.")).toBeTruthy();
    expect(
      screen.getByText(
        "Verdict scores are ratings; no Brier score or calibration is computed for them.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("0.710 (95% CI 0.520–0.860; 7 sent back / 11 not sent back)"),
    ).toBeTruthy();
    expect(screen.getByText("unmeasured — no sent-back gates in the scoring set")).toBeTruthy();
    expect(screen.getAllByText("unmeasured — fewer than 30 answered items").length).toBeGreaterThan(
      0,
    );
  });

  it("renders model populations with provider identity, calibration and paired baselines", async () => {
    await renderLoaded();
    // requestedModel null → "runner default"; reportedModel null → "not reported".
    expect(screen.getAllByText("runner default").length).toBeGreaterThan(0);
    expect(screen.getAllByText("not reported").length).toBeGreaterThan(0);
    expect(screen.getByText("claude-haiku-x")).toBeTruthy();
    expect(
      screen.getByText(
        "answered: 7 · abstained: 1 · provider-failed: 0 · refused: 2 · missing-input: 0 · construction-error: 0 · unrecorded: 0 · unknown-outcome: 0 · unresolved: 0",
      ),
    ).toBeTruthy();
    expect(screen.getByText("budget-exhausted: 2")).toBeTruthy();
    expect(screen.getByText("state-changed: 1")).toBeTruthy();

    // Measured and unmeasured calibration.
    expect(screen.getByText("unmeasured — n = 7 < 30")).toBeTruthy();
    expect(screen.getByText("unmeasured — n = 5 < 30")).toBeTruthy();
    expect(screen.getByText("0.214 (n = 40)")).toBeTruthy();
    expect(screen.getByText("0.061 (n = 40)")).toBeTruthy();

    // Reliability buckets: measured and unmeasured.
    const table = screen.getByRole("table", {
      name: "Reliability buckets for gate.operator-action@1 (Manual gates)",
    });
    expect(within(table).getByText("0.2–0.4")).toBeTruthy();
    expect(within(table).getByText("0.310")).toBeTruthy();
    expect(within(table).getByText("25.0%")).toBeTruthy();
    expect(within(table).getByText("unmeasured (n = 5)")).toBeTruthy();

    // Paired baselines.
    expect(screen.getAllByText("Deterministic baseline on the same items").length).toBe(2);
    expect(screen.getAllByText("Verdict baseline on the same items").length).toBe(2);
    expect(screen.getByText("75.0% (6/8)")).toBeTruthy();
    expect(screen.getByText("12.5% (1/8)")).toBeTruthy();

    // Usage.
    expect(screen.getAllByText("p50 1200 · p95 3400 · max 4100 ms (n = 8)").length).toBe(2);
    expect(
      screen.getAllByText(/total \$0.0412 · mean \$0.0051 \(known 8, unknown 0\)/).length,
    ).toBe(2);
  });

  it("renders spend, methods and the integrity findings", async () => {
    await renderLoaded();
    expect(screen.getByText("$0.0412")).toBeTruthy();
    expect(
      screen.getByText("Counts and money across all attempts, settled or not; never outcomes."),
    ).toBeTruthy();
    expect(screen.getByText("Revise and abort are sent back.")).toBeTruthy();
    expect(screen.getByText("incomplete")).toBeTruthy();
    expect(screen.getByText("line 12 is truncated")).toBeTruthy();
    expect(screen.getByText("missing segment")).toBeTruthy();
    expect(screen.getByText("attempt has no result record")).toBeTruthy();
    expect(screen.getByText("orphan-attempt · line 17 · HA-9")).toBeTruthy();
    expect(
      screen.getByText(/H1 report as of ledger record 99 \(2026-09-29T12:00:00.000Z\)/),
    ).toBeTruthy();
  });

  it("only issues a GET for /api/decisions/h1 and offers no controls", async () => {
    const spy = await renderLoaded();
    expect(spy).toHaveBeenCalled();
    for (const [input, init] of spy.mock.calls) {
      const url = typeof input === "string" ? input : (input as Request).url;
      expect(url).toBe("/api/decisions/h1");
      expect(init === undefined || init.method === undefined || init.method === "GET").toBe(true);
    }
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("reports a load failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({}),
    } as Response);
    render(<DecisionH1Section />);
    expect(await screen.findByText(/Couldn't load the H1 report: HTTP 500/)).toBeTruthy();
  });

  it("treats a malformed body as no report", async () => {
    mockFetch({ "/api/decisions/h1": () => okJson({ nope: true }) });
    render(<DecisionH1Section />);
    expect(await screen.findByText("No H1 report available.")).toBeTruthy();
  });
});
