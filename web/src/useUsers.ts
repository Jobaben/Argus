import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import { postJson } from "./useAuth";

import type { UserSummary } from "@argus/contracts";

/** Named `UserRow` in the UI; `UserSummary` on the wire. */
export type UserRow = UserSummary;

/** Root-only account list with approve/reject transitions. */
export function useUsers() {
  const { data, loading, error, refresh } = useLiveResource<UserRow[]>("/api/users", {
    select: (j) => (j as { users?: UserRow[] }).users ?? [],
    initial: [],
    pollMs: 30_000,
  });

  const act = useCallback(
    async (username: string, action: "approve" | "reject") => {
      await postJson(`/api/users/${encodeURIComponent(username)}/${action}`, {});
      refresh();
    },
    [refresh],
  );

  return {
    users: data ?? [],
    loading,
    error,
    refresh,
    approve: (u: string) => act(u, "approve"),
    reject: (u: string) => act(u, "reject"),
  };
}
