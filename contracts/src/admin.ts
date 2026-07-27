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
  service: "argus";
}
