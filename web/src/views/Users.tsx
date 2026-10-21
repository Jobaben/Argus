import { useEffect, useState } from "react";
import { useAuth } from "../useAuth";
import { useUsers, type UserRow } from "../useUsers";
import { AccountPrompt } from "./AccountPrompt";
import { sentenceStart } from "./text";
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
  Icon,
} from "../ds";
import { useConfirm } from "../ds/useConfirm";
import { loadError } from "../live/loadError";

/** An approve, reject or remove the server refused, and who it was for. */
type Refusal = { username: string; verb: string; reason: string };

/** What a refused action was, in the words of the button that asked for it. */
const verbFor = (user: UserRow, action: "approve" | "reject") =>
  action === "approve" ? "approve" : user.status === "pending" ? "reject" : "remove";

function UserItem({
  user,
  self,
  refusal,
  onApprove,
  onReject,
}: {
  user: UserRow;
  self: boolean;
  /** Said on the row it is about, as a card's footer says its own. */
  refusal: string | null;
  onApprove: (u: UserRow) => Promise<void>;
  onReject: (u: UserRow) => Promise<void>;
}) {
  const pending = user.status === "pending";
  // Reject and Remove both delete the account, and Remove also ends its
  // sessions; neither can be undone, so each asks first. Approve stays one
  // press: what it grants, Remove can take back.
  const confirm = useConfirm();
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
          {/* Badges in sentence case like every other; the role is the
              server's word ("root"), capitalised only as it is shown. */}
          <span className={chipClass()}>{sentenceStart(user.role)}</span>
          {self && <span className={chipClass()}>You</span>}
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
            aria-expanded={confirm.armed === "reject"}
            onClick={confirm.toggle("reject")}
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
            onClick={() => void onApprove(user)}
          >
            Approve
          </Button>
        )}
      </div>
      {confirm.armed === "reject" &&
        confirm.question(
          pending
            ? {
                title: `Reject ${user.username}'s request?`,
                detail: "The account is deleted, so the name can be registered again.",
                confirm: "Reject request",
                cancel: "Keep",
                icon: "close",
              }
            : {
                title: `Remove ${user.username}?`,
                detail: `The account is deleted, and anyone signed in as ${user.username} is signed out.`,
                confirm: "Remove account",
                cancel: "Keep",
                icon: "trash",
              },
          () => void onReject(user),
        )}
      {refusal && (
        <p
          role="alert"
          className="flex basis-full items-start gap-1.5 pl-11 text-caption text-fail-ink"
        >
          <Icon name="alert" size={14} className="mt-px shrink-0 text-fail" />
          <span className="min-w-0 break-words">{refusal}</span>
        </p>
      )}
    </li>
  );
}

/**
 * The account list, for root only. Its own component so that `/api/users` —
 * root-only on the server, refused to everyone else — is fetched only once the
 * session is known to be root's. Mounted for everyone, it was asked for on an
 * empty install and by every signed-out visitor, and its refusal was shown as
 * a load error under the very state that explained it.
 */
function AccountList({ self, onRecheck }: { self: string | null; onRecheck: () => void }) {
  const { users, loading, error, errorStatus, refresh, approve, reject } = useUsers();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // A session can end between two reads of the auth status (it expired, or
  // root signed out in another tab). That is not a fault in this page: the
  // status is re-read, and the page becomes whichever state it now is.
  // The server's refusals: 401 with no session, 403 for one that is not root's.
  const refused = errorStatus === 401 || errorStatus === 403;
  useEffect(() => {
    if (refused) onRecheck();
  }, [refused, onRecheck]);

  // A refusal is said as "Couldn't approve alice: user is not pending" — the
  // card footers' shape — and on alice's row. It used to be a strip at the top
  // of the page whose bold "Couldn't complete that" ran straight into the
  // server's clause, a screen away from the row it was about. The name stays
  // in the words because an alert is announced without the row around it.
  const guarded =
    (action: "approve" | "reject", fn: (u: string) => Promise<void>) => async (u: UserRow) => {
      setRefusal(null);
      try {
        await fn(u.username);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        setRefusal({ username: u.username, verb: verbFor(u, action), reason });
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
      refusal={
        refusal?.username === u.username
          ? `Couldn't ${refusal.verb} ${refusal.username}: ${refusal.reason}`
          : null
      }
      onApprove={guarded("approve", approve)}
      onReject={guarded("reject", reject)}
    />
  );

  return (
    <>
      {error && !refused && (
        <div className="mb-6">
          <AlertStrip
            subject="Accounts"
            message={loadError("users", error)}
            action={
              <Button size="sm" icon="retry" onClick={() => refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}
      {/* A row can go before its refusal does (someone else removed the
          account, and the list has caught up); the refusal is then said here,
          where it can still be read. */}
      {refusal && !users.some((u) => u.username === refusal.username) && (
        <div className="mb-6">
          <AlertStrip
            subject={`Couldn't ${refusal.verb} ${refusal.username}:`}
            message={refusal.reason}
            role="alert"
          />
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
        message={loadError("who is signed in", auth.error ?? "no answer", "check")}
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
