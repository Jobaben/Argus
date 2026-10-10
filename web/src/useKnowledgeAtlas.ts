import { useLiveResource } from "./live/useLiveResource";
import { atlasPath } from "./views/knowledgeModel";

import type { KnowledgeAtlas, KnowledgeScope } from "@argus/contracts";

/**
 * The Knowledge Ledger as one read model, whole or for one scope. The ledger
 * publishes no change event, so this polls; it changes only when a phase
 * commits knowledge, so a minute is plenty.
 */
export function useKnowledgeAtlas(scope: KnowledgeScope | null) {
  const { data, loading, error, refresh } = useLiveResource<KnowledgeAtlas | null>(
    atlasPath(scope),
    {
      select: (j) => {
        const r = j as Partial<KnowledgeAtlas> | null;
        return r && typeof r === "object" && Array.isArray(r.claims) && Array.isArray(r.scopes)
          ? (r as KnowledgeAtlas)
          : null;
      },
      initial: null,
      pollMs: 60_000,
    },
  );
  return { data, loading, error, refresh };
}
