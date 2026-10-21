import { useState } from "react";
import { useAuth } from "../useAuth";
import { useUsers, type UserRow } from "../useUsers";
import {
  AlertStrip,
  Button,
  ButtonLink,
  EmptyState,
  Handoff,
  Page,
  Section,
  SkeletonRows,
  TimeAgo,
  chipClass,
} from "../ds";

function UserItem({
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
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-4 py-3">
      <span
        aria-hidden="true"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-caption font-semibold uppercase ${
          pending
            ? "border-await/40 bg-await/10 text-await"
            : "border-line-strong bg-surface-2 text-ink-dim"
        }`}
      >
        {user.username.slice(0, 1)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {/* Wrapped, never cut: a pending name is what is being approved, so all
              of it has to be readable next to the button that grants it. */}
          <span
            className={`min-w-0 text-small font-semibold text-ink ${pending ? "break-words" : "truncate"}`}
            title={user.username}
          >
            {user.username}
          </span>
          <span className={chipClass()}>{user.role}</span>
          {self && <span className={chipClass()}>you</span>}
        </div>
        <div className="mt-0.5 text-caption text-ink-faint">
          {pending ? "Requested" : "Joined"} <TimeAgo iso={user.createdAt} />
        </div>
      </div>
      {/* The destructive choice on the left, quiet and set well apart from the
          one that grants access, which sits at the far end where the eye
          finishes. Quiet on every row, as Fleet's Unpair is: a column of red
          outlines reads as a column of failures. */}
      {/* On a phone a pending row's decision takes its own line, so the name it
          is about keeps the whole width above it. */}
      <div
        className={`ml-auto flex items-center gap-6 ${pending ? "w-full justify-end sm:w-auto" : ""}`}
      >
        {!self && (
          <Button
            size="sm"
            variant="quiet-danger"
            icon={pending ? "close" : "trash"}
            aria-label={`${pending ? "Reject" : "Remove"} ${user.username}`}
            onClick={() => void onReject(user.username)}
          >
            {pending ? "Reject" : "Remove"}
          </Button>
        )}
        {pending && (
          <Button
            size="sm"
            variant="approve"
            icon="check"
            aria-label={`Approve ${user.username}`}
            onClick={() => void onApprove(user.username)}
          >
            Approve
          </Button>
        )}
      </div>
    </li>
  );
}

export default function Users() {
  const auth = useAuth();
  const { users, loading, error, refresh, approve, reject } = useUsers();
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
  const pending = users.filter((u) => u.status === "pending");
  const active = users.filter((u) => u.status !== "pending");
  const item = (u: UserRow) => (
    <UserItem
      key={u.username}
      user={u}
      self={u.username === auth.status?.username}
      onApprove={guarded(approve)}
      onReject={guarded(reject)}
    />
  );

  return (
    <Page
      title="Users"
      subtitle="Who can sign in to this server. A new account stays locked until root approves it."
    >
      {auth.status && !auth.status.configured ? (
        // A fresh install has no root to sign in as; the first account made
        // becomes it, and the form that makes it is on the Pipelines tab.
        <EmptyState
          icon="shield"
          title="No root account yet"
          action={
            <ButtonLink href="#/pipelines" variant="primary" iconRight="arrow-right">
              Create the root account
            </ButtonLink>
          }
        >
          The first account created becomes root, and approves everyone who registers after it.
        </EmptyState>
      ) : auth.status && !isRoot ? (
        <EmptyState
          icon="shield"
          title={
            auth.status.authenticated
              ? "Only the root user can manage accounts."
              : "Sign in as root to manage accounts."
          }
          action={
            // The sign-in form lives on the Pipelines tab, which a reader landing
            // here has no way of knowing — this page was otherwise a dead end.
            !auth.status.authenticated && (
              <ButtonLink href="#/pipelines" variant="primary" iconRight="arrow-right">
                Sign in on the Pipelines tab
              </ButtonLink>
            )
          }
        >
          A new account is created immediately but stays locked until root approves it here, so a
          registration alone grants nothing.
        </EmptyState>
      ) : (
        <>
          {error && (
            <div className="mb-6">
              <AlertStrip
                subject="Accounts"
                message={`Couldn't load users: ${error}`}
                action={
                  <Button size="sm" icon="retry" onClick={() => refresh()}>
                    Retry
                  </Button>
                }
              />
            </div>
          )}
          {actionError && (
            <div className="mb-6">
              <AlertStrip subject="Couldn't complete that" message={actionError} />
            </div>
          )}
          <Handoff
            busy={loading && users.length === 0}
            label="accounts"
            skeleton={<SkeletonRows count={2} />}
          >
            {users.length === 0 ? (
              error ? null : (
                <EmptyState icon="user" title="No accounts yet.">
                  Accounts appear here as people register from the sign-in form.
                </EmptyState>
              )
            ) : (
              <>
                {/* Someone waiting to be let in is the one thing on this page that
                    needs a decision, so they come first and look like it. */}
                {pending.length > 0 && (
                  <Section title={`Waiting for approval · ${pending.length}`}>
                    <div className="relative overflow-hidden rounded-tile border border-await/35 bg-surface shadow-raised">
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-await"
                      />
                      <ul className="divide-y divide-line">{pending.map(item)}</ul>
                    </div>
                  </Section>
                )}
                {active.length > 0 && (
                  <Section title={`Accounts · ${active.length}`}>
                    <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
                      {active.map(item)}
                    </ul>
                  </Section>
                )}
              </>
            )}
          </Handoff>
        </>
      )}
    </Page>
  );
}
