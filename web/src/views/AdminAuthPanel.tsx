import { useId, useState, type FormEvent } from "react";
import { Button, Icon, fieldClass, labelClass } from "../ds";
import { sentenceStart } from "./text";

const FIELD = `${fieldClass} h-10 w-full px-3 text-sm`;

type Mode = "login" | "register";

/**
 * What the account is for, said where the form appears. The panel opens on
 * Pipelines, on Users and on the sign-in wall, and its reason used to be the
 * Pipelines one on all three — "editing or running pipelines" above a form
 * whose only use on the Users page is managing accounts.
 */
export type AuthPurpose = "pipelines" | "accounts" | "dashboard";

const REASON: Record<AuthPurpose, { setup: string; login: string }> = {
  pipelines: {
    setup:
      "Building, running and approving pipelines needs an admin account. This first one is root: it also approves every account after it.",
    login: "Editing or running pipelines requires a signed-in, root-approved account.",
  },
  accounts: {
    setup: "The first account is root. It approves every account registered after it, here.",
    login: "Approving and managing accounts is for the root user.",
  },
  dashboard: {
    setup:
      "This server has no accounts yet. The first one is root: it also approves every account after it.",
    login: "Use an account the root user has approved.",
  },
};

/**
 * Auth entry point for the pipeline control surface. Unconfigured servers get
 * the one-time root-bootstrap form (localhost only, enforced server-side);
 * configured servers get login with a switch to request a new account, which
 * lands pending until root approves it on the Users page.
 *
 * It says why before it asks. On a fresh install this is what "Build a
 * pipeline" lands on, and a bare credentials form there read as a detour; the
 * first line now names what the account is for. Where there is room (the
 * Pipelines page) the reason and the fields sit side by side, so the panel
 * spans the page like the content around it; in the narrow sign-in wall they
 * stack.
 *
 * It calls signing in "Sign in" throughout, as the button and every way into
 * it do; a "Login" heading over a "Sign in" button was one form using two
 * words for one act.
 */
export function AdminAuthPanel({
  configured,
  onLogin,
  onSetup,
  onRegister,
  purpose = "pipelines",
  autoFocus = false,
  headingLevel = 3,
  onCancel,
}: {
  configured: boolean;
  purpose?: AuthPurpose;
  onLogin: (username: string, password: string) => Promise<void>;
  onSetup: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, password: string) => Promise<void>;
  /** Put the caret in the first field on mount, where the form is the reason
   *  the page is open (the sign-in wall, or a form opened from a button). */
  autoFocus?: boolean;
  /** The title's level: 2 where the form is the page's main content under its
   *  h1, 3 where it sits inside a page that has its own sections. */
  headingLevel?: 2 | 3;
  /** Where the form was opened in place of something, the way back to it: a
   *  Cancel beside the submit, and Escape. */
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const registering = configured && mode === "register";
  const userId = useId();
  const passId = useId();
  const choosing = !configured || registering;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!configured) {
        await onSetup(username, password);
      } else if (registering) {
        await onRegister(username, password);
        setNotice("Account created — awaiting root approval. You can sign in once approved.");
        setUsername("");
      } else {
        await onLogin(username, password);
      }
      setPassword("");
    } catch (err) {
      // The server writes its refusals as clauses ("invalid username or
      // password"); said on their own, they start a sentence.
      setError(sentenceStart(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const title = !configured
    ? "Create the root account"
    : registering
      ? "Request an account"
      : "Sign in";
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <form
      onSubmit={(e) => void submit(e)}
      onKeyDown={
        onCancel
          ? (e) => {
              // An input method uses Escape to drop the word being composed;
              // that should not also throw away the form.
              if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              onCancel();
            }
          : undefined
      }
      className="@container rounded-panel border border-line bg-surface p-5 shadow-raised sm:p-6"
      aria-label={title}
    >
      <div className="grid gap-x-10 gap-y-5 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] @2xl:items-start">
        <div className="flex min-w-0 gap-3.5">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-ink-dim"
          >
            <Icon name={configured && !registering ? "user" : "shield"} size={19} />
          </span>
          <div className="min-w-0">
            <Heading className="text-heading font-semibold text-ink">{title}</Heading>
            <p className="mt-1 max-w-prose text-small text-ink-dim">
              {!configured
                ? REASON[purpose].setup
                : registering
                  ? "Your account will be created immediately but stays locked until the root user approves it."
                  : REASON[purpose].login}
            </p>
            {!configured && (
              <p className="mt-2.5 flex items-start gap-1.5 text-caption text-ink-faint">
                <Icon name="info" size={13} className="mt-px shrink-0" />
                Only works from the server's own machine. The password is stored only as a salted
                scrypt hash.
              </p>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {/* A placeholder is not a label: it disappears the moment you type,
              and a screen reader gets nothing to announce the field by. */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={userId} className={labelClass}>
              Username
            </label>
            <input
              id={userId}
              className={FIELD}
              placeholder={choosing ? "Choose a username" : "Your username"}
              autoComplete="username"
              autoFocus={autoFocus}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={passId} className={labelClass}>
              Password
              {choosing && (
                <span className="font-normal text-ink-faint"> · at least 8 characters</span>
              )}
            </label>
            <input
              id={passId}
              className={FIELD}
              type="password"
              placeholder={choosing ? "Choose a password" : "Your password"}
              autoComplete={choosing ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={choosing ? 8 : undefined}
              required
            />
          </div>

          {error && (
            <p role="alert" className="flex items-center gap-1.5 text-small text-fail-ink">
              <Icon name="alert" size={15} className="text-fail" />
              {error}
            </p>
          )}
          {notice && (
            <p className="flex items-center gap-1.5 text-small text-ok">
              <Icon name="check-circle" size={15} />
              {notice}
            </p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" size="lg" disabled={busy}>
              {!configured
                ? busy
                  ? "Creating…"
                  : "Create & sign in"
                : registering
                  ? busy
                    ? "Requesting…"
                    : "Request account"
                  : busy
                    ? "Signing in…"
                    : "Sign in"}
            </Button>
            {onCancel && (
              <Button variant="ghost" size="lg" onClick={onCancel}>
                Cancel
              </Button>
            )}
            {configured && (
              // A link-weight switch, padded out to a 32px target with the
              // padding taken back by a negative margin so the words stay
              // where they were; rounded so its focus ring is the controls'.
              <button
                type="button"
                className="-mx-1.5 inline-flex min-h-8 items-center rounded-control px-1.5 text-left text-small text-ink-dim underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink hover:decoration-ink-faint"
                onClick={() => {
                  setMode(registering ? "login" : "register");
                  setError(null);
                  setNotice(null);
                }}
              >
                {registering ? "Back to sign in" : "Need access? Request an account"}
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
