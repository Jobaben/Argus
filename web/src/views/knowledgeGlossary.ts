import type { ClaimKind } from "@argus/contracts";

/**
 * Every term the Knowledge view shows, in the ledger's own vocabulary
 * (docs/KNOWLEDGE-LEDGER.md). One source, so a legend, a tooltip and the field
 * guide can never disagree with each other or with the documentation.
 */

export type GlossaryAxis = "kind" | "support" | "lifecycle" | "conformance" | "currency" | "record";

export interface GlossaryEntry {
  term: string;
  axis: GlossaryAxis;
  definition: string;
  /** The distinction people most often get wrong, quoted from the doc. */
  note?: string;
  /** Section of docs/KNOWLEDGE-LEDGER.md that defines it. */
  docRef: string;
}

export const AXES: Array<{ axis: GlossaryAxis; title: string; question: string }> = [
  { axis: "kind", title: "Kind", question: "What sort of assertion is it?" },
  { axis: "support", title: "Support", question: "Why does Argus believe it?" },
  { axis: "conformance", title: "Conformance", question: "Has anyone checked the code obeys it?" },
  { axis: "lifecycle", title: "Lifecycle", question: "Is this the current wording?" },
  { axis: "currency", title: "Currency", question: "Is work built on it still sound?" },
  { axis: "record", title: "Records", question: "What the ledger is made of" },
];

export const KIND_TERMS: Record<ClaimKind, GlossaryEntry> = {
  "business-rule": {
    term: "Business rule",
    axis: "kind",
    definition:
      "A rule the business operates by, usually read out of the code that enforces it. First class, because rule impact analysis is the reason the ledger exists.",
    docRef: "§3",
  },
  constraint: {
    term: "Constraint",
    axis: "kind",
    definition:
      "A limit the system must respect: a technical or contractual boundary rather than a business policy.",
    docRef: "§3",
  },
  fact: {
    term: "Fact",
    axis: "kind",
    definition:
      "Something observed to be the case, such as what a system exposes or how it behaves today.",
    docRef: "§3",
  },
  assumption: {
    term: "Assumption",
    axis: "kind",
    definition:
      "Something taken to be true without direct proof. Worth knowing about before relying on it.",
    docRef: "§3",
  },
  conclusion: {
    term: "Conclusion",
    axis: "kind",
    definition:
      "A claim derived from other claims by a justification, rather than read directly from evidence.",
    docRef: "§5",
  },
  decision: {
    term: "Decision",
    axis: "kind",
    definition: "A choice made on the strength of other claims, such as what to build.",
    docRef: "§5",
  },
};

export type TermId =
  | "supported"
  | "unsupported"
  | "contested"
  | "active"
  | "superseded"
  | "holds"
  | "violated"
  | "unverifiable"
  | "unverified"
  | "current"
  | "stale"
  | "claim"
  | "evidence"
  | "justification"
  | "scope"
  | "unscoped";

export const TERMS: Record<TermId, GlossaryEntry> = {
  supported: {
    term: "Supported",
    axis: "support",
    definition: "At least one positive signal is in force and no negative one.",
    note: "Derived from evidence and justifications every time it is read. No agent can set it.",
    docRef: "§6",
  },
  unsupported: {
    term: "Unsupported",
    axis: "support",
    definition: "No positive signal is in force, whether or not a negative one is.",
    note: "Opposition alone is not contestation: a claim with only opposing evidence is unsupported.",
    docRef: "§6",
  },
  contested: {
    term: "Contested",
    axis: "support",
    definition: "Positive and negative signals are both in force.",
    docRef: "§6",
  },
  active: {
    term: "Active",
    axis: "lifecycle",
    definition: "The current revision of its id.",
    note: "Lifecycle and support are separate axes.",
    docRef: "§3",
  },
  superseded: {
    term: "Superseded",
    axis: "lifecycle",
    definition:
      "A later revision replaced this one. It stays addressable, and everything that named it keeps naming it.",
    note: "Lifecycle and support are separate axes: a superseded revision can still be fully supported.",
    docRef: "§7",
  },
  holds: {
    term: "Holds",
    axis: "conformance",
    definition: "A verification examined the implementation and found it obeys the rule.",
    docRef: "§15",
  },
  violated: {
    term: "Violated",
    axis: "conformance",
    definition: "A verification found the implementation does not obey the rule.",
    note: "A violation is not a doubt: the rule stays supported. The code is what disagrees.",
    docRef: "§15",
  },
  unverifiable: {
    term: "Unverifiable",
    axis: "conformance",
    definition: "Somebody looked and concluded the available evidence could not settle it.",
    docRef: "§15",
  },
  unverified: {
    term: "Unverified",
    axis: "conformance",
    definition: "No accepted verification exists. Nobody looked.",
    note: "Not the same as unverifiable, which means somebody looked and could not tell.",
    docRef: "§15",
  },
  current: {
    term: "Current",
    axis: "currency",
    definition: "Every revision an execution relied on is still active and supported.",
    docRef: "§9",
  },
  stale: {
    term: "Stale",
    axis: "currency",
    definition:
      "An execution relied on this revision and it is no longer active and supported. The run still succeeded; the world moved.",
    docRef: "§9",
  },
  claim: {
    term: "Claim",
    axis: "record",
    definition: "An addressable semantic assertion. Every revision is immutable once written.",
    docRef: "§3",
  },
  evidence: {
    term: "Evidence",
    axis: "record",
    definition:
      "A record of provenance bearing on one exact claim revision: where it came from, never a copy of the content.",
    docRef: "§4",
  },
  justification: {
    term: "Justification",
    axis: "record",
    definition:
      "These premise revisions, taken together, support (or oppose) this conclusion. In force only while every premise is active and supported.",
    docRef: "§5",
  },
  scope: {
    term: "Scope",
    axis: "record",
    definition: "The project and repository a claim belongs to. It is not a path and not a commit.",
    docRef: "§3a",
  },
  unscoped: {
    term: "Unscoped",
    axis: "record",
    definition:
      "A claim with no owning project. Absent means unknown: a scoped query never returns it.",
    docRef: "§3a",
  },
};
