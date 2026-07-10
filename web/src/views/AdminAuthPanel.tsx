import { useState, type FormEvent } from "react";

const FIELD =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder-ink-faint";

/**
 * Login (or, on first run, account-creation) form for the pipeline admin.
 * Which mode it renders is driven by whether an admin account exists yet.
 */
export function AdminAuthPanel({
  configured,
  onLogin,
  onSetup,
}: {
  configured: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
  onSetup: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await (configured ? onLogin(username, password) : onSetup(username, password));
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="max-w-md rounded-xl border border-line bg-surface p-4"
      aria-label={configured ? "Admin login" : "Create admin account"}
    >
      <h3 className="text-base font-semibold text-ink">
        {configured ? "Admin login" : "Create the admin account"}
      </h3>
      <p className="mt-1 text-xs text-ink-faint">
        {configured
          ? "Editing or running pipelines requires an admin session."
          : "First run: choose the admin credentials that will guard pipeline editing and runs. " +
            "The password is stored only as a salted scrypt hash."}
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
          placeholder={configured ? "Password" : "Password (min 8 characters)"}
          autoComplete={configured ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={configured ? undefined : 8}
          required
        />
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-fail">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="mt-3 rounded-lg bg-ok/20 px-3 py-1.5 text-sm text-ok ring-1 ring-ok/30 hover:bg-ok/30 disabled:opacity-50"
      >
        {configured ? (busy ? "Signing in…" : "Sign in") : busy ? "Creating…" : "Create & sign in"}
      </button>
    </form>
  );
}
