import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { H1ReportResponse, H2ReportResponse } from "@argus/contracts";
import DecisionExperiments from "./DecisionExperiments";

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

const usage = {
  latencyMs: { n: 8, p50: 1200, p95: 3400, max: 4100 },
  costUsd: { total: 0.0412, meanKnown: 0.0051, known: 8, unknown: 0 },
  tokens: { total: 9600, meanKnown: 1200, known: 8, unknown: 0 },
  snapshotBytes: { n: 8, p50: 2048, p95: 4096, max: 5120 },
};

const fixture: H2ReportResponse = {
  collection: {
    enabled: false,
    reasons: ["ARGUS_H2_COLLECT is not set", "probe rate is out of range"],
    settings: {
      residualRate: 0.05,
      probeRate: 0.25,
      maxCallsPer24h: 40,
      minCallIntervalMs: 90_000,
      maxUsdPer24h: 2,
      requestedModel: null,
      seed: "seed-7",
    },
    watcher: { state: "paused", detail: "daily cap reached", until: "2026-09-30T00:00:00.000Z" },
  },
  report: {
    report: { id: "decision-h2-report", version: 1 },
    asOf: { seq: 42, at: "2026-09-29T12:00:00.000Z" },
    collection: {
      start: "2026-09-20T08:00:00.000Z",
      configs: [
        {
          digest: "abcdef0123456789abcdef",
          firstAt: "2026-09-20T08:00:00.000Z",
          seed: "seed-7",
          rates: [{ id: "run.termination-probe", version: 1, rate: 0.25 }],
          window: { minAgeMs: 60_000, maxAgeMs: 86_400_000 },
          limits: {
            maxCallsPer24h: 40,
            minCallIntervalMs: 90_000,
            maxUsdPer24h: 2,
            maxTriesPerItem: 3,
            retryAfterMs: 60_000,
          },
          provider: { provider: "claude-cli", requestedModel: "haiku", adapterVersion: 2 },
          census: 12,
          attempts: 9,
        },
      ],
    },
    definitions: [],
    census: [
      {
        role: "probe",
        question: { id: "run.termination-probe", version: 1 },
        considered: 30,
        excluded: { "no-snapshot": 4 },
        strata: [
          {
            stratum: "exit-nonzero",
            eligible: 20,
            selected: 10,
            notSelected: 10,
            assessed: 8,
            lost: 1,
            constructionError: 0,
            expired: 1,
            abandoned: 0,
            pending: 0,
          },
        ],
      },
    ],
    probe: [
      {
        question: {
          id: "run.termination-probe",
          version: 1,
          digest: "d1",
          definition: "registered",
        },
        projection: { id: "run.termination-projection", version: 1, digest: "p1" },
        provider: {
          provider: "claude-cli",
          requestedModel: "haiku",
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
        usage,
        reference: {
          stream: "observed-termination",
          bearing: 8,
          excluded: { "reference-stale": 1 },
        },
        classes: [
          {
            label: "timeout",
            n: 8,
            answered: 7,
            abstained: 1,
            failed: 0,
            correct: 5,
            recallAnswered: { k: 5, n: 8, value: 0.625, ci95: [0.306, 0.863] },
            recallEndToEnd: { k: 0, n: 0, value: null, ci95: null },
          },
        ],
        confusion: {
          rows: ["timeout", "crash"],
          columns: ["timeout", "crash"],
          counts: [
            [5, 2],
            [0, 0],
          ],
        },
        ties: 0,
        accuracyAnswered: { k: 5, n: 8, value: 0.625, ci95: [0.306, 0.863] },
        coverage: { k: 7, n: 8, value: 0.875, ci95: [0.529, 0.978] },
        accuracyEndToEnd: { k: 5, n: 8, value: 0.625, ci95: null },
        macroRecall: { answered: 0.5, endToEnd: null },
        majorityClassShare: 0.75,
        kappa: { status: "unmeasured", reason: "one reference class" },
        brier: { status: "measured", value: { value: 0.412, n: 7 } },
        reliability: {
          minBucket: 200,
          buckets: [
            {
              lower: 0.8,
              upper: 0.9,
              n: 250,
              status: "measured",
              meanConfidence: 0.85,
              accuracy: 0.7,
            },
            {
              lower: 0.9,
              upper: 1,
              n: 5,
              status: "unmeasured",
              meanConfidence: null,
              accuracy: null,
            },
          ],
        },
        ece: { status: "unmeasured", reason: "n = 5 < 200" },
      },
    ],
    residual: [
      {
        question: {
          id: "run.failure-cause.residual",
          version: 1,
          digest: "d2",
          definition: "registered",
        },
        projection: { id: "run.failure-projection", version: 1, digest: "p2" },
        provider: {
          provider: "claude-cli",
          requestedModel: null,
          reportedModel: "claude-haiku-x",
          adapterVersion: 2,
          elicitation: "verbalized",
        },
        attempts: {
          answered: 3,
          abstained: 0,
          "provider-failed": 1,
          refused: 0,
          "missing-input": 0,
          "construction-error": 0,
          unrecorded: 0,
          "unknown-outcome": 0,
          unresolved: 0,
        },
        assessed: 4,
        answered: 3,
        abstained: 0,
        failed: 1,
        refusals: {},
        usage,
        strata: [{ stratum: "not-derivable", assessed: 4, answered: 3, abstained: 0, failed: 1 }],
        accuracy: { status: "unmeasured", reason: "no valid reference labels exist" },
        probability: { status: "unmeasured", reason: "no valid reference labels exist" },
        topAnswers: { "env-drift": 2, "test-flake": 1 },
      },
    ],
    baselines: [
      { provider: "deterministic", status: "not-compared", reason: "no shared reference yet" },
      { provider: "autopsy", status: "not-applicable", reason: "different question" },
    ],
    outsideExperiment: 3,
    methods: { proportions: "Wilson 95% intervals.", attempts: "Every attempt is counted." },
    integrity: {
      history: "incomplete",
      ledger: [],
      journal: {
        gaps: 1,
        notices: [{ kind: "gap", segment: "seg-2", line: null, detail: "missing segment" }],
      },
      findings: [
        {
          kind: "orphan-attempt",
          line: 17,
          attemptId: "DA-9",
          detail: "attempt has no result record",
        },
      ],
    },
  },
};

/** The smallest valid H1 report: the page also renders it, and an unmocked path throws. */
const h1Fixture: H1ReportResponse = {
  collection: {
    enabled: false,
    reasons: [],
    settings: null,
    watcher: { state: "inactive", detail: null, until: null },
  },
  report: {
    report: { id: "decision-h1-report", version: 1 },
    asOf: { seq: 7, at: null },
    statement: "Behavioural agreement cannot justify skipping review.",
    collection: { start: null, configs: [] },
    definitions: [],
    gates: { excluded: {} },
    census: [],
    pending: { total: 0, byPopulation: { manual: 0, "auto-approve-declared": 0 } },
    deterministic: [],
    verdict: [],
    models: [],
    spend: { attempts: 0, spent: 0, usdTotal: 0, usdUnknown: 0 },
    methods: {},
    integrity: {
      history: "complete",
      ledger: [],
      journal: { gaps: 0, notices: [] },
      findings: [],
    },
  },
};

describe("DecisionExperiments view", () => {
  it("renders the shadow-only notice, identity, formatted metrics and unmeasured text", async () => {
    mockFetch({
      "/api/decisions/h2": () => okJson(fixture),
      "/api/decisions/h1": () => okJson(h1Fixture),
    });
    render(<DecisionExperiments />);

    expect(await screen.findByText(/Shadow measurement only\./)).toBeTruthy();
    expect(screen.getByText(/nothing here authorises an approval/)).toBeTruthy();
    expect(
      screen.getByText(/Residual-cause accuracy is unmeasured until valid reference labels/),
    ).toBeTruthy();

    // Collection (off): reasons and settings.
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.getByText("probe rate is out of range")).toBeTruthy();
    expect(screen.getByText("5%")).toBeTruthy();
    expect(screen.getByText("1.5 min")).toBeTruthy();
    expect(screen.getByText("abcdef012345")).toBeTruthy();

    // Identity header.
    expect(screen.getAllByText("haiku").length).toBeGreaterThan(0);
    expect(screen.getAllByText("not reported").length).toBeGreaterThan(0);
    expect(screen.getByText("runner default")).toBeTruthy();

    // Proportions and unmeasured values.
    expect(screen.getAllByText("62.5% (5/8, 95% CI 30.6–86.3%)").length).toBeGreaterThan(0);
    expect(screen.getByText("— (n = 0)")).toBeTruthy();
    expect(screen.getByText("unmeasured — n = 5 < 200")).toBeTruthy();
    expect(screen.getByText("unmeasured — one reference class")).toBeTruthy();
    expect(screen.getByText("0.412 (n = 7)")).toBeTruthy();
    expect(screen.getByText("unmeasured (n < 200)")).toBeTruthy();
    expect(screen.getByText("Accuracy (answered only)")).toBeTruthy();
    expect(screen.getByText(/Majority-class share — accuracy near this/)).toBeTruthy();

    // Confusion matrix row header and counts.
    const matrix = screen.getByRole("table", { name: /Confusion matrix/ });
    expect(within(matrix).getByRole("rowheader", { name: "crash" })).toBeTruthy();

    // Residual: accuracy is never shown, top answers are flagged descriptive.
    expect(screen.getAllByText(/Unmeasured — no valid reference labels exist/).length).toBe(2);
    expect(screen.getByText("Top-answer counts (descriptive — not accuracy)")).toBeTruthy();
    expect(screen.getByText("env-drift: 2")).toBeTruthy();

    // Baselines, integrity, methods, footer.
    expect(screen.getByText("deterministic — not-compared — no shared reference yet")).toBeTruthy();
    expect(screen.getByText("attempt has no result record")).toBeTruthy();
    expect(screen.getByText("missing segment")).toBeTruthy();
    expect(screen.getAllByText("No findings.").length).toBe(1);
    expect(screen.getByText("Wilson 95% intervals.")).toBeTruthy();
    expect(screen.getByText(/As of ledger record 42 \(2026-09-29T12:00:00.000Z\)/)).toBeTruthy();

    // Nothing in the page claims a verdict.
    expect(document.body.textContent).not.toMatch(/\b(approved|passed|good|safe)\b/i);
  });

  it("only issues a GET for the report and offers no mutating controls", async () => {
    const spy = mockFetch({
      "/api/decisions/h2": () => okJson(fixture),
      "/api/decisions/h1": () => okJson(h1Fixture),
    });
    render(<DecisionExperiments />);
    await screen.findByText(/Shadow measurement only\./);
    await screen.findByText("Top-answer counts (descriptive — not accuracy)");

    expect(spy).toHaveBeenCalled();
    for (const [input, init] of spy.mock.calls) {
      const url = typeof input === "string" ? input : (input as Request).url;
      expect(["/api/decisions/h2", "/api/decisions/h1"]).toContain(url);
      expect(init === undefined || init.method === undefined || init.method === "GET").toBe(true);
    }
    const buttons = screen.queryAllByRole("button");
    for (const b of buttons) {
      expect(b.textContent).not.toMatch(/enable|disable|approve|re-?evaluate|collect/i);
    }
    expect(buttons).toHaveLength(0);
  });

  it("shows the empty state when there are no probe or residual populations", async () => {
    const empty: H2ReportResponse = {
      ...fixture,
      collection: {
        ...fixture.collection,
        enabled: true,
        reasons: [],
        settings: null,
        watcher: { state: "inactive", detail: null, until: null },
      },
      report: {
        ...fixture.report,
        asOf: { seq: 0, at: null },
        collection: { start: null, configs: [] },
        census: [],
        probe: [],
        residual: [],
        baselines: [],
        methods: {},
        integrity: {
          history: "complete",
          ledger: [],
          journal: { gaps: 0, notices: [] },
          findings: [],
        },
      },
    };
    mockFetch({
      "/api/decisions/h2": () => okJson(empty),
      "/api/decisions/h1": () => okJson(h1Fixture),
    });
    render(<DecisionExperiments />);

    expect(await screen.findByText("No shadow assessments recorded.")).toBeTruthy();
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("No valid settings.")).toBeTruthy();
    expect(screen.getByText("No collection config recorded.")).toBeTruthy();
    expect(screen.getByText("No census recorded.")).toBeTruthy();
    expect(screen.getByText("No baselines.")).toBeTruthy();
    expect(screen.getAllByText("No findings.").length).toBe(3);
    expect(screen.getByText(/As of ledger record 0 \(no records\)/)).toBeTruthy();
    expect(screen.queryByText(/Probe: run.termination-probe/)).toBeNull();
  });

  it("reports a load failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({}),
    } as Response);
    render(<DecisionExperiments />);
    expect(await screen.findByText(/Couldn't load the H2 report: HTTP 500/)).toBeTruthy();
  });

  it("treats a malformed body as no report", async () => {
    mockFetch({
      "/api/decisions/h2": () => okJson({ nope: true }),
      "/api/decisions/h1": () => okJson(h1Fixture),
    });
    render(<DecisionExperiments />);
    expect(await screen.findByText("No report available.")).toBeTruthy();
  });
});
