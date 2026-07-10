import { useState, type FormEvent } from "react";

const FIELD =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder-ink-faint";

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

  const title = !configured ? "Create the root account" : registering ? "Request an account" : "Login";

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="max-w-md rounded-xl border border-line bg-surface p-4"
      aria-label={title}
    >
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-xs text-ink-faint">
        {!configured
          ? "First run: choose the root credentials that will guard pipeline editing, runs, " +
            "and account approvals. Only works from the server's own machine. " +
            "The password is stored only as a salted scrypt hash."
          : registering
            ? "Your account will be created immediately but stays locked until the root user approves it."
            : "Editing or running pipelines requires a signed-in, root-approved account."}
      </p>

      <div className="mt-3 grid gap-2">
        <input
          className={FIELD}
          placeholder="Username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <input
          className={FIELD}
          type="password"
          placeholder={configured && !registering ? "Password" : "Password (min 8 characters)"}
          autoComplete={configured && !registering ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={configured && !registering ? undefined : 8}
          required
        />
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-fail">
          {error}
        </p>
      )}
      {notice && <p className="mt-2 text-xs text-ok">{notice}</p>}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ok/20 px-3 py-1.5 text-sm text-ok ring-1 ring-ok/30 hover:bg-ok/30 disabled:opacity-50"
        >
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
        </button>
        {configured && (
          <button
            type="button"
            className="text-xs text-ink-dim underline hover:text-ink"
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
