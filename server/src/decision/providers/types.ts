import type {
  DecisionOutcome,
  DecisionProviderKind,
  DecisionQuestion,
  ProviderIdentity,
  StoredSnapshot,
} from "@argus/contracts";
import type { AnalysisDispatchAdmission } from "../../sources/analysis.js";

export type DispatchAdmission = AnalysisDispatchAdmission;

/**
 * The provider seam (RFC §G.1). A provider evaluates one registered question
 * against one retained snapshot and reports what it said and who said it.
 * It never names a transition, never writes, and never sees anything but the
 * snapshot it is handed.
 *
 * The identity is returned per call, because the requested model is resolved
 * at call time (the runner's configured default, or an explicit override),
 * and the reported model is only known from the response.
 */
export interface ProviderResponse {
  executionDisposition?: "not-called" | "possibly-called";
  identity: ProviderIdentity;
  outcome: DecisionOutcome;
  costUsd: number | null;
  tokens: number | null;
}

export interface DecisionProvider {
  readonly kind: DecisionProviderKind;
  /** The identity it would report before any response: used when a call throws. */
  identity(): ProviderIdentity;
  supports(q: DecisionQuestion): boolean;
  assess(
    q: DecisionQuestion,
    snapshot: StoredSnapshot,
    signal: AbortSignal,
  ): Promise<ProviderResponse>;
  assessWithAdmission?(q: DecisionQuestion, snapshot: StoredSnapshot, signal: AbortSignal, admission: DispatchAdmission): Promise<ProviderResponse>;
}
