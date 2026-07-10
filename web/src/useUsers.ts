import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import { postJson } from "./useAuth";

export interface UserRow {
  username: string;
  role: "root" | "member";
  status: "pending" | "active";
  createdAt: string;
}

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
