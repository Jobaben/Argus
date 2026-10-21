import { useEffect, useState } from "react";
import { useAuth } from "../useAuth";
import { useUsers, type UserRow } from "../useUsers";
import { AccountPrompt } from "./AccountPrompt";
import {
  AlertStrip,
  Button,
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

/** The server's refusals — 401 with no session, 403 for a session that is not
 *  root's — as `useLiveResource` words them. */
const REFUSED = /^HTTP 40[13]$/;

/**
 * The account list, for root only. Its own component so that `/api/users` —
 * root-only on the server, refused to everyone else — is fetched only once the
 * session is known to be root's. Mounted for everyone, it was asked for on an
 * empty install and by every signed-out visitor, and its refusal was shown as
 * a load error under the very state that explained it.
 */
function AccountList({ self, onRecheck }: { self: string | null; onRecheck: () => void }) {
  const { users, loading, error, refresh, approve, reject } = useUsers();
  const [actionError, setActionError] = useState<string | null>(null);
  // A session can end between two reads of the auth status (it expired, or
  // root signed out in another tab). That is not a fault in this page: the
  // status is re-read, and the page becomes whichever state it now is.
  const refused = error !== null && REFUSED.test(error);
  useEffect(() => {
    if (refused) onRecheck();
  }, [refused, onRecheck]);

  const guarded = (fn: (u: string) => Promise<void>) => async (u: string) => {
    setActionError(null);
    try {
      await fn(u);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      onRecheck();
    }
  };

  const pending = users.filter((u) => u.status === "pending");
  const active = users.filter((u) => u.status !== "pending");
  const item = (u: UserRow) => (
    <UserItem
      key={u.username}
      user={u}
      self={u.username === self}
      onApprove={guarded(approve)}
      onReject={guarded(reject)}
    />
  );

  return (
    <>
      {error && !refused && (
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
          <AlertStrip subject="Couldn't complete that" message={actionError} role="alert" />
        </div>
      )}
      <Handoff
        busy={(loading || refused) && users.length === 0}
        label="accounts"
        skeleton={<SkeletonRows count={2} />}
      >
        {users.length === 0 ? (
          error ? null : (
            <EmptyState icon="user" title="No accounts yet">
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
  );
}

export default function Users() {
  const auth = useAuth();
  const { status } = auth;
  const recheck = auth.refresh;

  const body =
    status === null ? (
      <AlertStrip
        subject="Accounts"
        message={`Couldn't check who is signed in: ${auth.error ?? "no answer"}`}
        action={
          <Button size="sm" icon="retry" onClick={() => recheck()}>
            Retry
          </Button>
        }
      />
    ) : !status.configured || !status.authenticated ? (
      // What the server allows here: on a fresh install the first account,
      // which becomes root (from the server's own machine only); otherwise a
      // sign-in, or a request for an account that root then approves. The
      // form opens in place — it used to live on the Pipelines tab, which a
      // reader landing here had no way of knowing.
      <AccountPrompt
        configured={status.configured}
        onLogin={auth.login}
        onSetup={auth.setup}
        onRegister={auth.register}
        purpose="accounts"
        icon="shield"
        title={status.configured ? "Sign in as root to manage accounts" : "No root account yet"}
      >
        {status.configured
          ? "A new account is created immediately but stays locked until root approves it here, so a registration alone grants nothing."
          : "The first account created becomes root, and approves everyone who registers after it."}
      </AccountPrompt>
    ) : status.role !== "root" ? (
      <EmptyState icon="shield" title="Only the root user can manage accounts">
        A new account is created immediately but stays locked until root approves it here, so a
        registration alone grants nothing.
      </EmptyState>
    ) : (
      <AccountList self={status.username} onRecheck={recheck} />
    );

  return (
    <Page
      title="Users"
      subtitle="Who can sign in to this server. A new account stays locked until root approves it."
    >
      {/* Whose page this is is not known until the status lands. Guessing
          would flash a sign-in form at root, or ask the server for a list it
          may refuse. */}
      <Handoff
        busy={status === null && auth.loading}
        label="accounts"
        skeleton={<SkeletonRows count={2} />}
      >
        {body}
      </Handoff>
    </Page>
  );
}
