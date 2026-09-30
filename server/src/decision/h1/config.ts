/**
 * H1 collection settings (RFC §Q.1, §Q.7, §Q.8).
 *
 * Collection is off unless an operator turns on **both** switches:
 * `ARGUS_DECISIONS=on` and `ARGUS_DECISIONS_H1_COLLECT=on`.
 * `ARGUS_ANALYSIS=off` wins over both, because every provider call is an
 * analysis pass. A setting that does not parse disables collection and is
 * named; nothing falls back to a guess.
 */

export interface H1Limits {
  /** Combined H1 + H2 provider invocations per rolling 24 hours this experiment will add to. */
  maxCallsPer24h: number;
  /** H1's own invocations per rolling 24 hours: its share of the combined allowance. */
  maxOwnCallsPer24h: number;
  /** Since the last provider invocation of either experiment. */
  minCallIntervalMs: number;
  /** Combined recorded H1 + H2 cost per rolling 24 hours. */
  maxUsdPer24h: number;
  maxTriesPerItem: number;
  retryAfterMs: number;
}

export interface H1Settings {
  seed: string;
  rate: number;
  /** One per arm; null = the runner's default model. Never more than one call per item. */
  models: Array<string | null>;
  observation: {
    /** At most one re-observation of an item this often. */
    minIntervalMs: number;
    /** An action bracketed by observations further apart than this is `state-unobserved`. */
    maxBracketMs: number;
    /** Observation stops this long after capture. */
    maxPendingMs: number;
    /** How long an `incomplete` decision is waited for. */
    settleWaitMs: number;
  };
  limits: H1Limits;
}

export type H1Enablement =
  | { enabled: true; settings: H1Settings }
  | { enabled: false; reasons: string[]; settings: H1Settings | null };

const MINUTE = 60_000;

export const H1_DEFAULTS: Readonly<H1Settings> = Object.freeze({
  seed: "argus-h1",
  rate: 1,
  models: [null],
  observation: Object.freeze({
    minIntervalMs: MINUTE,
    maxBracketMs: 10 * MINUTE,
    maxPendingMs: 7 * 24 * 60 * MINUTE,
    settleWaitMs: 60 * MINUTE,
  }),
  limits: Object.freeze({
    maxCallsPer24h: 20,
    maxOwnCallsPer24h: 10,
    minCallIntervalMs: 15 * MINUTE,
    maxUsdPer24h: 1,
    maxTriesPerItem: 3,
    retryAfterMs: 30 * MINUTE,
  }),
}) as H1Settings;

/** Model aliases the Claude CLI resolves itself, and pinned ids. Nothing else is guessed at. */
const MODEL_RE = /^(?:haiku|sonnet|opus|claude-[a-z0-9.-]{1,80})$/;

type Env = Readonly<Record<string, string | undefined>>;

const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";

export function readH1Settings(env: Env): { settings: H1Settings; errors: string[] } {
  const errors: string[] = [];
  const text = (name: string) => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  const d = H1_DEFAULTS;
  const rateText = text("ARGUS_DECISIONS_H1_RATE");
  let rate = d.rate;
  if (rateText !== undefined) {
    const n = Number(rateText);
    if (!/^\d*\.?\d+$/.test(rateText) || !Number.isFinite(n) || n < 0 || n > 1) {
      errors.push(`ARGUS_DECISIONS_H1_RATE="${rateText}" is not a rate between 0 and 1`);
    } else rate = n;
  }
  const int = (name: string, dflt: number, min: number, max: number) => {
    const v = text(name);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < min || n > max) {
      errors.push(`${name}="${v}" is not a whole number from ${min} to ${max}`);
      return dflt;
    }
    return n;
  };
  const usdText = text("ARGUS_DECISIONS_H1_MAX_USD_PER_DAY");
  let maxUsd = d.limits.maxUsdPer24h;
  if (usdText !== undefined) {
    const n = Number(usdText);
    if (!/^\d*\.?\d+$/.test(usdText) || !Number.isFinite(n) || n < 0 || n > 1000) {
      errors.push(
        `ARGUS_DECISIONS_H1_MAX_USD_PER_DAY="${usdText}" is not a dollar amount from 0 to 1000`,
      );
    } else maxUsd = n;
  }
  const seed = text("ARGUS_DECISIONS_H1_SEED") ?? d.seed;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(seed)) {
    errors.push(`ARGUS_DECISIONS_H1_SEED="${seed}" must be 1-64 letters, digits, ".", "_" or "-"`);
  }
  let models: Array<string | null> = [...d.models];
  const modelsText = text("ARGUS_DECISIONS_H1_MODELS");
  if (modelsText !== undefined) {
    const list = modelsText.split(",").map((m) => m.trim());
    const bad = list.filter((m) => !MODEL_RE.test(m));
    if (bad.length > 0 || list.length > 3 || new Set(list).size !== list.length) {
      errors.push(
        `ARGUS_DECISIONS_H1_MODELS="${modelsText}" must be one to three distinct entries, each haiku, sonnet, opus or a claude-… id`,
      );
    } else models = list;
  }
  const maxCalls = int("ARGUS_DECISIONS_H1_MAX_CALLS_PER_DAY", d.limits.maxCallsPer24h, 0, 96);
  const maxOwn = int("ARGUS_DECISIONS_H1_MAX_OWN_CALLS_PER_DAY", d.limits.maxOwnCallsPer24h, 0, 96);
  if (maxOwn > maxCalls) {
    errors.push(
      `ARGUS_DECISIONS_H1_MAX_OWN_CALLS_PER_DAY (${maxOwn}) exceeds ARGUS_DECISIONS_H1_MAX_CALLS_PER_DAY (${maxCalls})`,
    );
  }
  const settings: H1Settings = {
    seed,
    rate,
    models,
    observation: { ...d.observation },
    limits: {
      ...d.limits,
      maxCallsPer24h: maxCalls,
      maxOwnCallsPer24h: maxOwn,
      minCallIntervalMs:
        int(
          "ARGUS_DECISIONS_H1_MIN_INTERVAL_MINUTES",
          d.limits.minCallIntervalMs / MINUTE,
          1,
          1440,
        ) * MINUTE,
      maxUsdPer24h: maxUsd,
    },
  };
  return { settings, errors };
}

/** Whether H1 collection may run, and why not. Reads only the environment it is handed. */
export function h1Enablement(env: Env): H1Enablement {
  const reasons: string[] = [];
  if (!on(env.ARGUS_DECISIONS)) reasons.push("ARGUS_DECISIONS is not on");
  if (!on(env.ARGUS_DECISIONS_H1_COLLECT)) reasons.push("ARGUS_DECISIONS_H1_COLLECT is not on");
  if ((env.ARGUS_ANALYSIS ?? "").trim().toLowerCase() === "off") {
    reasons.push("analysis passes are disabled (ARGUS_ANALYSIS=off)");
  }
  const { settings, errors } = readH1Settings(env);
  reasons.push(...errors);
  if (reasons.length > 0)
    return { enabled: false, reasons, settings: errors.length ? null : settings };
  return { enabled: true, settings };
}
