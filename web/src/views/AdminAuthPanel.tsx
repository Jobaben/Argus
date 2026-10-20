import { useState, type FormEvent } from "react";
import { Button, Icon, fieldClass } from "../ds";

const FIELD = `${fieldClass} h-10 w-full px-3 text-sm`;

type Mode = "login" | "register";

/**
 * Auth entry point for the pipeline control surface. Unconfigured servers get
 * the one-time root-bootstrap form (localhost only, enforced server-side);
 * configured servers get login with a switch to request a new account, which
 * lands pending until root approves it on the Users page.
 */
export function AdminAuthPanel({
  configured,
  onLogin,
  onSetup,
  onRegister,
}: {
  configured: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
  onSetup: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, password: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const registering = configured && mode === "register";

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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const title = !configured
    ? "Create the root account"
    : registering
      ? "Request an account"
      : "Login";

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="max-w-md rounded-panel border border-line bg-surface p-5 shadow-raised"
      aria-label={title}
    >
      <h3 className="text-heading font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-small text-ink-dim">
        {!configured
          ? "First run: choose the root credentials that will guard pipeline editing, runs, " +
            "and account approvals. Only works from the server's own machine. " +
            "The password is stored only as a salted scrypt hash."
          : registering
            ? "Your account will be created immediately but stays locked until the root user approves it."
            : "Editing or running pipelines requires a signed-in, root-approved account."}
      </p>

      <div className="mt-4 grid gap-2.5">
        {/* A placeholder is not a label: it disappears the moment you type, and
            a screen reader gets nothing to announce the field by. */}
        <input
          className={FIELD}
          aria-label="Username"
          placeholder="Username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <input
          className={FIELD}
          type="password"
          aria-label="Password"
          placeholder={configured && !registering ? "Password" : "Password (min 8 characters)"}
          autoComplete={configured && !registering ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={configured && !registering ? undefined : 8}
          required
        />
      </div>

      {error && (
        <p role="alert" className="mt-3 flex items-center gap-1.5 text-small text-fail-ink">
          <Icon name="alert" size={15} className="text-fail" />
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 flex items-center gap-1.5 text-small text-ok">
          <Icon name="check-circle" size={15} />
          {notice}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
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
        {configured && (
          <button
            type="button"
            className="text-small text-ink-dim underline decoration-line-strong underline-offset-4 transition hover:text-ink hover:decoration-ink-faint"
            onClick={() => {
              setMode(registering ? "login" : "register");
              setError(null);
              setNotice(null);
            }}
          >
            {registering ? "Back to login" : "Need access? Request an account"}
          </button>
        )}
      </div>
    </form>
  );
}
