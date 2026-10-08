import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AtlasClaim, KnowledgeAtlas } from "@argus/contracts";
import KnowledgeView from "./KnowledgeView";

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

function mockFetch(handlers: Record<string, () => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const handler = handlers[path];
    if (!handler) throw new Error(`unmocked fetch: ${path}`);
    return handler();
  });
}

const SCOPE = { projectId: "motorit-online", repositoryId: "git:dev.azure.com/org/p/_git/online" };

function claim(over: Partial<AtlasClaim>): AtlasClaim {
  return {
    id: "RULE-1e8f9f4e.2a88aaca",
    revision: 1,
    kind: "business-rule",
    statement: "[Commerce] Carts expire after 30 minutes.",
    scope: SCOPE,
    createdAt: "2026-10-01T00:00:00.000Z",
    producedBy: { instanceId: "inst-1", phaseId: "rules-foundation", runId: "run-7" },
    lifecycle: "active",
    support: "supported",
    evidence: [
      {
        id: "EV-1",
        direction: "supports",
        source: {
          type: "source-code",
          path: "src/Commerce/Cart.cs",
          startLine: 4,
          endLine: 9,
          symbol: "Cart.Expire",
        },
      },
    ],
    conformance: "unverified",
    consumers: 0,
    stale: false,
    ...over,
  };
}

const RULE = claim({});
const atlas: KnowledgeAtlas = {
  scope: null,
  scopes: [
    { scope: SCOPE, claims: 3 },
    { scope: null, claims: 1 },
  ],
  claims: [
    RULE,
    claim({
      id: "RULE-aa11bb22.2a88aaca",
      statement: "[Commerce] Totals include VAT.",
      support: "contested",
    }),
    claim({
      id: "FACT-cc33dd44.2a88aaca",
      kind: "fact",
      statement: "[Search] Results are paged by 20.",
      conformance: null,
      evidence: [
        {
          id: "EV-2",
          direction: "supports",
          source: { type: "source-code", path: "src/Search/Pager.cs" },
        },
      ],
    }),
    claim({
      id: "FACT-b77b1ef5",
      kind: "fact",
      statement: "Unowned fact.",
      scope: undefined,
      conformance: null,
    }),
  ],
  justifications: [],
};

const detailBase = `/api/knowledge/claims/${encodeURIComponent(`${RULE.id}:v1`)}`;
const handlers = {
  "/api/knowledge/atlas": () => okJson(atlas),
  [`${detailBase}/support`]: () =>
    okJson({
      claim: { id: RULE.id, revision: 1 },
      lifecycle: "active",
      support: "supported",
      evidence: [],
      justifications: [],
    }),
  [`${detailBase}/consumers`]: () =>
    okJson({ claim: { id: RULE.id, revision: 1 }, consumptions: [] }),
  [`${detailBase}/supplied-to`]: () =>
    okJson({
      claim: { id: RULE.id, revision: 1 },
      executions: [
        { execution: { runId: "run-9" }, suppliedAt: "2026-10-02T00:00:00.000Z", sha256: "x" },
      ],
    }),
  [`${detailBase}/conformance`]: () =>
    okJson({ rule: { id: RULE.id, revision: 1 }, status: "unverified", history: [] }),
};

describe("KnowledgeView", () => {
  it("opens on a calm overview that says nobody verified the rules", async () => {
    mockFetch(handlers);
    render(<KnowledgeView />);
    expect(await screen.findByRole("heading", { name: "What Argus believes" })).toBeInTheDocument();
    const summary = screen.getByText(/nobody has checked them against the code yet/);
    expect(summary).toHaveTextContent("4 claims, 2 business rules");
    expect(summary).toHaveTextContent("1 needs a look");
    expect(summary).toHaveTextContent("none verified");

    // Shelves: Commerce (2), Search (1), and the unowned claim on its own.
    expect(screen.getByRole("button", { name: /Commerce/ })).toHaveTextContent("Cart.cs");
    expect(screen.getByRole("button", { name: /Search/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Unscoped/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Knowledge scope" })).toHaveTextContent(
      "All knowledge (4)",
    );
  });

  it("opens a shelf into its claims, flagging only the exception", async () => {
    const user = userEvent.setup();
    mockFetch(handlers);
    render(<KnowledgeView />);
    await user.click(await screen.findByRole("button", { name: /Commerce/ }));

    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Commerce");
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Carts expire after 30 minutes.")).toBeInTheDocument();
    expect(screen.getAllByText("Contested")).toHaveLength(1);
    expect(screen.queryByText("Paged")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Knowledge" }));
    expect(screen.getByRole("radiogroup", { name: "Group claims by" })).toBeInTheDocument();
  });

  it("searches across every claim, including file paths", async () => {
    const user = userEvent.setup();
    mockFetch(handlers);
    render(<KnowledgeView />);
    await user.type(await screen.findByRole("searchbox"), "pager");
    expect(screen.getByText("Results are paged by 20.")).toBeInTheDocument();
    expect(screen.queryByText("Carts expire after 30 minutes.")).toBeNull();
  });

  it("filters to what needs a look and by kind", async () => {
    const user = userEvent.setup();
    mockFetch(handlers);
    render(<KnowledgeView />);
    await user.click(await screen.findByRole("button", { name: /Only what needs a look/ }));
    expect(screen.getByText("Totals include VAT.")).toBeInTheDocument();
    expect(screen.queryByText("Carts expire after 30 minutes.")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Only what needs a look/ }));
    await user.click(
      within(screen.getByRole("group", { name: "Filter by kind" })).getByRole("button", {
        name: /Fact/,
      }),
    );
    expect(screen.getByText("Unowned fact.")).toBeInTheDocument();
    expect(screen.queryByText("Totals include VAT.")).toBeNull();
  });

  it("opens a claim's drawer with its evidence, conformance and who was given it", async () => {
    const user = userEvent.setup();
    mockFetch(handlers);
    render(<KnowledgeView />);
    await user.click(await screen.findByRole("button", { name: /Commerce/ }));
    await user.click(screen.getByText("Carts expire after 30 minutes."));

    const drawer = await screen.findByRole("dialog");
    expect(drawer).toHaveTextContent(`${RULE.id}:v1`);
    expect(drawer).toHaveTextContent("src/Commerce/Cart.cs:4-9 · Cart.Expire");
    expect(drawer).toHaveTextContent("1 source supports it, and nothing opposes it.");
    expect(drawer).toHaveTextContent("Nobody looked.");
    expect(await within(drawer).findByRole("link", { name: "run-9" })).toHaveAttribute(
      "href",
      "#/run/run-9",
    );
    expect(within(drawer).getByRole("link", { name: "rules-foundation" })).toHaveAttribute(
      "href",
      "#/run/run-7",
    );
  });

  it("shows a revised, violated rule's justification, history and consumers, and follows a premise", async () => {
    const user = userEvent.setup();
    const ruleRef = { id: "RULE-17", revision: 2 };
    const factRef = { id: "FACT-12", revision: 1 };
    const revised: KnowledgeAtlas = {
      ...atlas,
      claims: [
        claim({
          id: "RULE-17",
          statement: "[Kobra] Comments are at most 180 characters.",
          lifecycle: "superseded",
          support: "unsupported",
        }),
        claim({
          id: "RULE-17",
          revision: 2,
          statement: "[Kobra] Comments are at most 500 characters.",
          revisionNote: "Kobra 4.2 raised the limit.",
          conformance: "violated",
          consumers: 1,
          evidence: [
            { id: "EV-5", direction: "supports", source: { type: "human", who: "product owner" } },
            { id: "EV-6", direction: "opposes", source: { type: "git-commit", sha: "abcdef0123" } },
          ],
        }),
        claim({
          id: "FACT-12",
          kind: "fact",
          statement: "[Kobra] Comments are free text.",
          conformance: null,
          producedBy: undefined,
        }),
      ],
    };
    const path = (ref: { id: string; revision: number }, tail: string) =>
      `/api/knowledge/claims/${encodeURIComponent(`${ref.id}:v${ref.revision}`)}/${tail}`;
    mockFetch({
      "/api/knowledge/atlas": () => okJson(revised),
      [path(ruleRef, "support")]: () =>
        okJson({
          claim: ruleRef,
          lifecycle: "active",
          support: "supported",
          evidence: [],
          justifications: [
            {
              justification: {
                id: "J-1",
                conclusion: ruleRef,
                premises: [factRef],
                direction: "supports",
                createdAt: "2026-10-01T00:00:00.000Z",
              },
              force: { inForce: false, failing: [{ premise: factRef, reason: "unsupported" }] },
            },
          ],
        }),
      [path(ruleRef, "consumers")]: () =>
        okJson({
          claim: ruleRef,
          consumptions: [
            {
              claim: ruleRef,
              execution: { runId: "run-3" },
              createdAt: "2026-10-02T00:00:00.000Z",
            },
          ],
        }),
      [path(ruleRef, "supplied-to")]: () => okJson({ claim: ruleRef, executions: [] }),
      [path(ruleRef, "conformance")]: () =>
        okJson({
          rule: ruleRef,
          status: "violated",
          latest: { execution: { runId: "run-v" }, repository: { gitHead: "1234567890ab" } },
          history: [],
        }),
      [path(factRef, "support")]: () =>
        okJson({
          claim: factRef,
          lifecycle: "active",
          support: "supported",
          evidence: [],
          justifications: [],
        }),
      [path(factRef, "consumers")]: () => okJson({ claim: factRef, consumptions: [] }),
      [path(factRef, "supplied-to")]: () => okJson({ claim: factRef, executions: [] }),
    });
    render(<KnowledgeView />);
    await user.type(await screen.findByRole("searchbox"), "500");
    await user.click(screen.getByText("Comments are at most 500 characters."));

    const drawer = await screen.findByRole("dialog");
    expect(drawer).toHaveTextContent(
      "1 source supports it, 1 source opposes it, 1 justification bears on it.",
    );
    expect(drawer).toHaveTextContent("commit abcdef01");
    expect(drawer).toHaveTextContent("Violated");
    expect(await within(drawer).findByText("out of force")).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: "run-v" })).toBeInTheDocument();
    expect(drawer).toHaveTextContent("at 12345678");
    expect(within(drawer).getByRole("link", { name: "run-3" })).toBeInTheDocument();
    expect(drawer).toHaveTextContent("Kobra 4.2 raised the limit.");
    expect(within(drawer).getByRole("button", { name: "v1" })).toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "FACT-12:v1" }));
    expect(
      await screen.findByText("Recorded directly, not by a run", { exact: false }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/No run has used or been given this claim yet/),
    ).toBeInTheDocument();
  });

  it("explains a term in place and closes it with Escape", async () => {
    const user = userEvent.setup();
    mockFetch(handlers);
    render(<KnowledgeView />);
    await user.click(await screen.findByRole("button", { name: "verified" }));
    expect(screen.getByRole("dialog", { name: "Unverified" })).toHaveTextContent("Nobody looked.");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Unverified" })).toBeNull();
  });

  it("opens the field guide with every axis explained", async () => {
    const user = userEvent.setup();
    mockFetch(handlers);
    render(<KnowledgeView />);
    await user.click(await screen.findByRole("button", { name: /How to read this page/ }));
    for (const axis of ["Kind", "Support", "Conformance", "Lifecycle", "Currency"]) {
      expect(screen.getByLabelText(axis)).toBeInTheDocument();
    }
    expect(screen.getByText(/normal says nothing/)).toBeInTheDocument();
  });

  it("asks for one scope when it is picked", async () => {
    const user = userEvent.setup();
    const scopedPath = `/api/knowledge/atlas?project=motorit-online&repository=${encodeURIComponent(
      SCOPE.repositoryId,
    )}`;
    const fetchSpy = mockFetch({
      ...handlers,
      [scopedPath]: () => okJson({ ...atlas, scope: SCOPE, claims: atlas.claims.slice(0, 3) }),
    });
    render(<KnowledgeView />);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Knowledge scope" }),
      "motorit-online/" + SCOPE.repositoryId,
    );
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("project=motorit-online"))).toBe(
      true,
    );
    expect(await screen.findByText(/3 claims/)).toBeInTheDocument();
  });

  it("explains an empty ledger instead of showing nothing", async () => {
    mockFetch({ "/api/knowledge/atlas": () => okJson({ ...atlas, scopes: [], claims: [] }) });
    render(<KnowledgeView />);
    expect(await screen.findByText(/The ledger holds no knowledge yet/)).toBeInTheDocument();
  });
});
