import { useState } from "react";
import { useAuth } from "../useAuth";
import { useUsers, type UserRow } from "../useUsers";
import { AlertStrip, EmptyState, Page } from "../ds";

function UserCard({
  user,
  self,
  onApprove,
  onReject,
}: {
  user: UserRow;
  self: boolean;
  onApprove: (u: string) => Promise<void>;
  onReject: (u: string) => Promise<void>;
}) {
  const pending = user.status === "pending";
  return (
    <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
      <div>
        <span className="text-sm font-medium text-ink">{user.username}</span>
        <span className="ml-2 text-xs text-ink-faint">
          {user.role}
          {pending ? " · awaiting approval" : ""}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {pending && (
          <button
            type="button"
            aria-label={`Approve ${user.username}`}
            onClick={() => void onApprove(user.username)}
            className="rounded-lg bg-ok/20 px-3 py-1 text-xs text-ok ring-1 ring-ok/30 hover:bg-ok/30"
          >
            Approve
          </button>
        )}
        {!self && (
          <button
            type="button"
            aria-label={`${pending ? "Reject" : "Remove"} ${user.username}`}
            onClick={() => void onReject(user.username)}
            className="rounded-lg bg-fail/10 px-3 py-1 text-xs text-fail ring-1 ring-fail/30 hover:bg-fail/20"
          >
            {pending ? "Reject" : "Remove"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function Users() {
  const auth = useAuth();
  const { users, loading, error, approve, reject } = useUsers();
  const [actionError, setActionError] = useState<string | null>(null);

  const guarded = (fn: (u: string) => Promise<void>) => async (u: string) => {
    setActionError(null);
    try {
      await fn(u);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      void auth.refresh();
    }
  };

  const isRoot = auth.status?.role === "root";
  const pendingFirst = [...users].sort(
    (a, b) => Number(b.status === "pending") - Number(a.status === "pending"),
  );

  return (
    <Page title="Users">
      {auth.status && !isRoot ? (
        <EmptyState>
          Only the root user can manage accounts. Registrations wait here until root approves
          them.
        </EmptyState>
      ) : (
        <>
          {error && (
            <div className="mb-6">
              <AlertStrip subject="Error" message={`Couldn't load users: ${error}`} />
            </div>
          )}
          {actionError && (
            <div className="mb-6">
              <AlertStrip subject="Couldn't complete that" message={actionError} />
            </div>
          )}
          {!loading && users.length === 0 ? (
            <EmptyState>No accounts yet.</EmptyState>
          ) : (
            <div className="grid gap-2">
              {pendingFirst.map((u) => (
                <UserCard
                  key={u.username}
                  user={u}
                  self={u.username === auth.status?.username}
                  onApprove={guarded(approve)}
                  onReject={guarded(reject)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
