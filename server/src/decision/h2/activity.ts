import type { AnalysisRunner } from "../../sources/analysis.js";

/**
 * Counts the analysis passes other features start, so H2 collection can stay
 * out of their way (RFC §P.4).
 *
 * The wrapper only delegates: `run` and `inFlight` are the wrapped runner's
 * own, so its concurrency gate, timeout, output cap, spend metering and
 * budget stop are unchanged, and it is still one runner for the whole
 * process. The Decision Plane's own `decide` passes are not counted.
 */
export interface CountingRunner extends AnalysisRunner {
  /** Non-`decide` passes started through this runner since the process began. */
  passesStarted(): number;
}

export function countAnalysisPasses(inner: AnalysisRunner): CountingRunner {
  let started = 0;
  return {
    run(req, parse) {
      if (req.kind !== "decide") started++;
      return inner.run(req, parse);
    },
    ...(typeof inner.runWithAdmission === "function" ? {
      runWithAdmission: ((req, parse, admission) => {
        if (req.kind !== "decide") started++;
        return inner.runWithAdmission!(req, parse, admission);
      }) as NonNullable<AnalysisRunner["runWithAdmission"]>,
    } : {}),
    inFlight: () => inner.inFlight(),
    passesStarted: () => started,
  };
}
