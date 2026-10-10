import { describe, it, expect } from "vitest";
import type { AtlasClaim, KnowledgeAtlas } from "@argus/contracts";
import {
  atlasPath,
  describeSource,
  exceptionOf,
  filterClaims,
  groupClaims,
  kindCounts,
  moduleOf,
  NO_FILTER,
  revisionsOf,
  scopeLabel,
  shortId,
  stripModule,
  summarize,
} from "./knowledgeModel";

const SCOPE = {
  projectId: "motorit-online",
  repositoryId: "git:dev.azure.com/org/p/_git/motoritonline",
};

function claim(over: Partial<AtlasClaim> = {}): AtlasClaim {
  return {
    id: "RULE-1e8f9f4e.2a88aaca",
    revision: 1,
    kind: "business-rule",
    statement: "[Commerce] Carts expire after 30 minutes.",
    scope: SCOPE,
    createdAt: "2026-10-01T00:00:00.000Z",
    lifecycle: "active",
    support: "supported",
    evidence: [
      {
        id: "EV-1",
        direction: "supports",
        source: { type: "source-code", path: "src/Commerce/Cart.cs", startLine: 4, endLine: 9 },
      },
    ],
    conformance: "unverified",
    consumers: 0,
    stale: false,
    ...over,
  };
}

function atlas(claims: AtlasClaim[]): KnowledgeAtlas {
  return { scope: null, scopes: [], claims, justifications: [] };
}

describe("naming", () => {
  it("reads and strips the discovery module prefix", () => {
    expect(moduleOf("[Search.Shared] Results are paged")).toBe("Search.Shared");
    expect(moduleOf("No prefix here")).toBeNull();
    expect(stripModule("[Commerce]  Carts expire")).toBe("Carts expire");
  });

  it("shortens scoped hashed ids and leaves readable ones alone", () => {
    expect(shortId("RULE-1e8f9f4e.2a88aaca")).toBe("RULE-1e8f");
    expect(shortId("BUSINESS-RULE-03874194")).toBe("BUSINESS-RULE-0387");
    expect(shortId("RULE-17")).toBe("RULE-17");
  });

  it("labels scopes by repository and builds the scoped atlas path", () => {
    expect(scopeLabel(null)).toBe("Unscoped");
    expect(scopeLabel(SCOPE)).toBe("motorit-online · motoritonline");
    expect(scopeLabel({ projectId: "kobra", repositoryId: "git:x/kobra" })).toBe("kobra");
    expect(atlasPath(null)).toBe("/api/knowledge/atlas");
    expect(atlasPath(SCOPE)).toBe(
      "/api/knowledge/atlas?project=motorit-online&repository=git%3Adev.azure.com%2Forg%2Fp%2F_git%2Fmotoritonline",
    );
  });

  it("describes every evidence source", () => {
    expect(
      describeSource({
        type: "source-code",
        path: "a/B.cs",
        startLine: 8,
        endLine: 35,
        gitHead: "09ce3741abcdef",
        symbol: "B.Rank",
      }),
    ).toBe("a/B.cs:8-35@09ce3741 · B.Rank");
    expect(describeSource({ type: "source-code", path: "a/B.cs", line: 3 })).toBe("a/B.cs:3");
    expect(describeSource({ type: "source-code", path: "a/B.cs" })).toBe("a/B.cs");
    expect(describeSource({ type: "human", who: "owner" })).toBe("stated by owner");
    expect(describeSource({ type: "run", runId: "r1" })).toBe("run r1");
    expect(describeSource({ type: "phase", instanceId: "i", phaseId: "p" })).toBe("phase i/p");
    expect(describeSource({ type: "artifact", instanceId: "i", phaseId: "p", path: "x.md" })).toBe(
      "artifact x.md (i/p)",
    );
    expect(describeSource({ type: "verification", instanceId: "i", phaseId: "p" })).toBe(
      "verification i/p",
    );
    expect(describeSource({ type: "git-commit", sha: "abcdef0123", repository: "r" })).toBe(
      "commit abcdef01 in r",
    );
    expect(describeSource({ type: "document", uri: "u", title: "T" })).toBe("T (u)");
    expect(describeSource({ type: "document", uri: "u" })).toBe("u");
  });
});

describe("exceptions", () => {
  it("says nothing about a normal claim", () => {
    expect(exceptionOf(claim())).toBeNull();
  });

  it("flags the most serious condition first", () => {
    expect(exceptionOf(claim({ support: "contested", stale: true }))?.term).toBe("contested");
    expect(exceptionOf(claim({ conformance: "violated" }))).toEqual({
      term: "violated",
      tone: "fail",
    });
    expect(exceptionOf(claim({ stale: true, lifecycle: "superseded" }))?.term).toBe("stale");
    expect(exceptionOf(claim({ lifecycle: "superseded", support: "unsupported" }))?.term).toBe(
      "superseded",
    );
    expect(exceptionOf(claim({ support: "unsupported" }))).toEqual({
      term: "unsupported",
      tone: "run",
    });
  });
});

describe("summary and counts", () => {
  it("counts active claims and says how many rules anyone verified", () => {
    const a = atlas([
      claim({ id: "RULE-A" }),
      claim({ id: "RULE-B", conformance: "holds" }),
      claim({ id: "FACT-A", kind: "fact", conformance: null, support: "unsupported" }),
      claim({ id: "RULE-A", revision: 0, lifecycle: "superseded" }),
    ]);
    expect(summarize(a)).toEqual({
      claims: 3,
      rules: 2,
      supported: 2,
      verified: 1,
      exceptions: 1,
      superseded: 1,
    });
    expect(kindCounts(a.claims.filter((c) => c.lifecycle === "active"))).toEqual([
      { kind: "business-rule", count: 2 },
      { kind: "fact", count: 1 },
    ]);
  });

  it("lists every revision of an id, oldest first", () => {
    const a = atlas([claim({ revision: 2 }), claim({ id: "X" }), claim({ revision: 1 })]);
    expect(revisionsOf(a, "RULE-1e8f9f4e.2a88aaca").map((c) => c.revision)).toEqual([1, 2]);
  });
});

describe("grouping", () => {
  const claims = [
    claim({ id: "RULE-1" }),
    claim({ id: "RULE-2", statement: "[Commerce] Totals include VAT", support: "contested" }),
    claim({
      id: "RULE-3",
      statement: "[Search] Results are paged",
      evidence: [
        {
          id: "EV-3",
          direction: "supports",
          source: { type: "source-code", path: "src/Search/Pager.cs" },
        },
        {
          id: "EV-4",
          direction: "supports",
          source: { type: "source-code", path: "src/Commerce/Cart.cs" },
        },
      ],
    }),
    claim({ id: "RULE-4", statement: "No prefix", evidence: [] }),
    claim({ id: "FACT-9", kind: "fact", statement: "Unowned", scope: undefined }),
  ];

  it("shelves by module, largest first, catch-alls last", () => {
    const groups = groupClaims(claims, "module");
    expect(groups.map((g) => [g.label, g.claims.length])).toEqual([
      ["Commerce", 2],
      ["Search", 1],
      ["Other", 1],
      ["Unscoped", 1],
    ]);
    expect(groups[0].exceptions).toBe(1);
    expect(groups[0].topFiles).toEqual(["Cart.cs"]);
  });

  it("shelves by file, a claim under every file it cites", () => {
    const groups = groupClaims(claims, "file");
    const cart = groups.find((g) => g.key === "src/Commerce/Cart.cs")!;
    expect(cart.label).toBe("Cart.cs");
    expect(cart.detail).toBe("src/Commerce");
    expect(cart.claims.map((c) => c.id)).toEqual(["RULE-1", "RULE-2", "RULE-3", "FACT-9"]);
    expect(groups.at(-1)?.label).toBe("No code reference");
  });

  it("filters by text, kind and exceptions", () => {
    expect(filterClaims(claims, { ...NO_FILTER, query: "vat" }).map((c) => c.id)).toEqual([
      "RULE-2",
    ]);
    expect(filterClaims(claims, { ...NO_FILTER, query: "pager" }).map((c) => c.id)).toEqual([
      "RULE-3",
    ]);
    expect(filterClaims(claims, { ...NO_FILTER, kind: "fact" }).map((c) => c.id)).toEqual([
      "FACT-9",
    ]);
    expect(filterClaims(claims, { ...NO_FILTER, exceptionsOnly: true }).map((c) => c.id)).toEqual([
      "RULE-2",
    ]);
  });
});
