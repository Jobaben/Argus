import { useLiveResource } from "./live/useLiveResource";

import type {
  ClaimKind,
  ConsumersReport,
  RuleConformanceReport,
  SuppliedToReport,
  SupportReport,
} from "@argus/contracts";

function objectWith<T>(key: string) {
  return (j: unknown): T | null => (j && typeof j === "object" && key in j ? (j as T) : null);
}

/**
 * Everything the claim drawer shows beyond the atlas row: why it is supported,
 * who relied on it, who was handed it, and (for a rule) the verification that
 * decides its conformance. Nothing is fetched while no claim is selected.
 */
export function useClaimDetail(claim: { id: string; revision: number; kind: ClaimKind } | null) {
  const base = claim
    ? `/api/knowledge/claims/${encodeURIComponent(`${claim.id}:v${claim.revision}`)}`
    : null;
  const opts = { initial: null, pollMs: 60_000 } as const;

  const support = useLiveResource<SupportReport | null>(base && `${base}/support`, {
    ...opts,
    select: objectWith<SupportReport>("evidence"),
  });
  const consumers = useLiveResource<ConsumersReport | null>(base && `${base}/consumers`, {
    ...opts,
    select: objectWith<ConsumersReport>("consumptions"),
  });
  const suppliedTo = useLiveResource<SuppliedToReport | null>(base && `${base}/supplied-to`, {
    ...opts,
    select: objectWith<SuppliedToReport>("executions"),
  });
  const conformance = useLiveResource<RuleConformanceReport | null>(
    base && claim?.kind === "business-rule" ? `${base}/conformance` : null,
    { ...opts, select: objectWith<RuleConformanceReport>("status") },
  );

  return {
    support: support.data,
    consumers: consumers.data,
    suppliedTo: suppliedTo.data,
    conformance: conformance.data,
    loading: support.loading && !support.data,
    error: support.error ?? consumers.error ?? suppliedTo.error ?? conformance.error,
  };
}
