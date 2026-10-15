/** The privileged control-plane surface: auth, users, setup, totals, health. */

export type Role = "root" | "member";
export type UserStatus = "pending" | "active";

export interface UserSummary {
  username: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
}

export interface AuthStatus {
  /** Whether any admin account exists yet. */
  configured: boolean;
  authenticated: boolean;
  username: string | null;
  role: Role | null;
  /**
   * Whether ordinary API reads need a logged-in session — true exactly when the
   * server has `ARGUS_TOKEN` set, which a browser cannot present.
   *
   * The UI cannot infer this: signed out on a loopback server the dashboard
   * reads fine, and signed out on a token-gated one every panel 401s. Without
   * the flag it would either gate a local server that needs no login, or mount
   * a dashboard whose every request is refused.
   */
  sessionRequired: boolean;
}

export type PrereqStatus = "ok" | "missing" | "outdated" | "error";

export interface PrereqResult {
  id: string;
  label: string;
  status: PrereqStatus;
  fixable: boolean;
  detail?: string;
}

/** All-time spend, accumulated at the run-completion choke point. */
export interface Totals {
  usd: number;
  tokens: number;
  runsCounted: number;
  since: string;
}

export interface HealthResponse {
  ok: true;
  version: string;
  claudeHome: string;
  /** Where Codex keeps its state, watched the same way `claudeHome` is. */
  codexHome: string;
  service: "argus";
  /** Which build is serving: a pinned release (`argus release`) or the dev
   *  checkout. Optional so older servers still satisfy the shape. */
  build?: BuildInfo;
}

export interface BuildInfo {
  kind: "release" | "dev";
  /** The commit it was built from; null when a dev checkout's git is unreadable. */
  sha: string | null;
  /** The directory the server runs from. */
  dir: string;
  /** The release id (`<version>-<sha7>`); absent on a dev build. */
  id?: string;
}
