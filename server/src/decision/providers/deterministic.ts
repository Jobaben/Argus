import type {
  DecisionOutcome,
  DecisionQuestion,
  ProviderIdentity,
  StoredSnapshot,
} from "@argus/contracts";
import { interpretDistribution } from "../answers.js";
import type { DecisionProvider, ProviderResponse } from "./types.js";

/**
 * The deterministic provider (RFC §G.1): a pure rule evaluator,
 * `elicitation: "rule"`, the baseline a model provider has to beat.
 *
 * A rule is a pure function of the question and the retained snapshot, keyed
 * by `question id@version`, so a rule written for v1 never silently answers
 * v2. It returns a distribution (usually one-hot), or an abstention.
 *
 * **Phase 1 ships no production rules** (§O.4). Observed termination is an
 * observation, not an assessment. No rule can infer a residual cause, and
 * answering the probe from withheld fields would be circular. So
 * `supports()` is false for both H2 questions, and the registry of rules is
 * supplied by the caller.
 */
export type DeterministicRule = (
  q: DecisionQuestion,
  snapshot: StoredSnapshot,
) => { distribution: unknown } | { abstain: string };

export const DETERMINISTIC_ADAPTER_VERSION = 1;

export function createDeterministicProvider(
  rules: ReadonlyMap<string, DeterministicRule> = new Map(),
): DecisionProvider {
  const key = (q: DecisionQuestion) => `${q.id}@${q.version}`;
  const identity = (): ProviderIdentity => ({
    provider: "deterministic",
    requestedModel: null,
    reportedModel: null,
    adapterVersion: DETERMINISTIC_ADAPTER_VERSION,
    elicitation: "rule",
  });
  return {
    kind: "deterministic",
    identity,
    supports: (q) => rules.has(key(q)),
    async assess(q, snapshot): Promise<ProviderResponse> {
      const base = { identity: identity(), costUsd: null, tokens: null };
      const rule = rules.get(key(q));
      if (!rule) {
        return {
          ...base,
          outcome: { status: "failed", failure: "unsupported", detail: `no rule for ${key(q)}` },
        };
      }
      const said = rule(q, snapshot);
      if ("abstain" in said)
        return { ...base, outcome: { status: "abstained", reason: said.abstain } };
      const read = interpretDistribution(q.answers, said.distribution);
      const outcome: DecisionOutcome = read.ok
        ? {
            status: "answered",
            answer: read.answer,
            ...(read.normalization ? { normalization: read.normalization } : {}),
          }
        : { status: "failed", failure: "invalid-answer", detail: read.reason };
      return { ...base, outcome };
    },
  };
}
