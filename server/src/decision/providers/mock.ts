import type {
  DecisionOutcome,
  DecisionQuestion,
  ProviderIdentity,
  StoredSnapshot,
} from "@argus/contracts";
import { interpretDistribution } from "../answers.js";
import type { DecisionProvider, ProviderResponse } from "./types.js";

/**
 * A scripted provider for tests. Each call consumes the next script step:
 *
 * - `{ distribution }` goes through the same `interpretDistribution` a real
 *   adapter uses, so invalid shapes fail honestly;
 * - `{ outcome }` is passed through verbatim, so tests can check that the
 *   service re-validates whatever a provider claims;
 * - `{ throws }` rejects, as a crashing adapter would.
 *
 * Every call is recorded in `calls`, which is how replay tests prove that no
 * provider was consulted.
 */
export type MockStep =
  | { distribution: unknown; rationale?: string }
  | { outcome: DecisionOutcome }
  | { abstain: string }
  | { throws: string };

export interface MockProvider extends DecisionProvider {
  calls: Array<{ question: string; version: number; snapshot: string }>;
}

export function createMockProvider(opts: {
  script: MockStep[] | ((q: DecisionQuestion, s: StoredSnapshot, call: number) => MockStep);
  identity?: Partial<Omit<ProviderIdentity, "provider">>;
  supports?: (q: DecisionQuestion) => boolean;
  costUsd?: number | null;
  tokens?: number | null;
}): MockProvider {
  const identity: ProviderIdentity = {
    provider: "mock",
    requestedModel: null,
    reportedModel: null,
    adapterVersion: 1,
    elicitation: "rule",
    ...opts.identity,
  };
  const calls: MockProvider["calls"] = [];
  return {
    kind: "mock",
    calls,
    identity: () => ({ ...identity }),
    supports: opts.supports ?? (() => true),
    async assess(q, snapshot): Promise<ProviderResponse> {
      const n = calls.length;
      calls.push({ question: q.id, version: q.version, snapshot: snapshot.sha256 });
      const step = typeof opts.script === "function" ? opts.script(q, snapshot, n) : opts.script[n];
      if (!step) throw new Error(`mock provider: no script step for call ${n}`);
      const base = {
        identity: { ...identity },
        costUsd: opts.costUsd ?? null,
        tokens: opts.tokens ?? null,
      };
      if ("throws" in step) throw new Error(step.throws);
      if ("outcome" in step) return { ...base, outcome: step.outcome };
      if ("abstain" in step)
        return { ...base, outcome: { status: "abstained", reason: step.abstain } };
      const read = interpretDistribution(q.answers, step.distribution);
      if (!read.ok) {
        return {
          ...base,
          outcome: { status: "failed", failure: "invalid-answer", detail: read.reason },
        };
      }
      const outcome: DecisionOutcome = { status: "answered", answer: read.answer };
      if (read.normalization) outcome.normalization = read.normalization;
      if (step.rationale) outcome.rationale = step.rationale;
      return { ...base, outcome };
    },
  };
}
