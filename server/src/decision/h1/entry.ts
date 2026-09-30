import path from "node:path";
import type { H1CollectionStatus, H1ReportResponse } from "@argus/contracts";
import { paths } from "../../claudeHome.js";
import { isSpendBlocked } from "../../sources/budget.js";
import { decisionsRoot, defaultSources, providerWorkdir } from "../definitions.js";
import type { CountingRunner } from "../h2/activity.js";
import { DecisionJournal } from "../journal.js";
import { createClaudeCliProvider } from "../providers/claudeCli.js";
import type { DecisionProvider } from "../providers/types.js";
import { createDecisionService } from "../service.js";
import { defaultH1Sources, type H1Sources } from "./collect.js";
import { h1Enablement, type H1Enablement } from "./config.js";
import { H1_BUILDERS, h1Registry } from "./definitions.js";
import { H1Ledger } from "./ledger.js";
import { replayH1 } from "./report.js";
import { H1SnapshotStore } from "./snapshots.js";
import { createH1Watcher, spentFrom, type H1Watcher, type ShadowSpend } from "./watcher.js";

/**
 * The H1 collection and its report (RFC §Q). Built by `decision/experiments.ts`
 * beside H2; `app.ts` reads the report. Building it touches no file: the
 * ledger, the snapshot store and the provider's empty working directory are
 * created only by an enabled watcher.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Where the H1 ledger and snapshot store live: beside the journal, never inside it. */
export function h1Root(): string {
  return path.join(paths.argus(), "decision-experiments", "h1");
}

function statusOf(
  en: H1Enablement,
  watcher: H1CollectionStatus["watcher"] | null,
): H1CollectionStatus {
  const s = en.settings;
  return {
    enabled: en.enabled,
    reasons: en.enabled ? [] : en.reasons,
    settings: s
      ? {
          rate: s.rate,
          seed: s.seed,
          models: [...s.models],
          maxCallsPer24h: s.limits.maxCallsPer24h,
          maxOwnCallsPer24h: s.limits.maxOwnCallsPer24h,
          minCallIntervalMs: s.limits.minCallIntervalMs,
          maxUsdPer24h: s.limits.maxUsdPer24h,
        }
      : null,
    watcher: watcher ?? {
      state: "inactive",
      detail: en.enabled ? "not started in this process" : null,
      until: null,
    },
  };
}

export interface H1Collection {
  watcher: H1Watcher;
  status(): H1CollectionStatus;
  /** Spent invocations in the H1 ledger, for H2's combined limits. Reads only. */
  spent(): Promise<ShadowSpend[]>;
}

export function createH1Collection(opts: {
  runner: CountingRunner;
  env?: Env;
  now?: () => Date;
  sources?: H1Sources;
  otherSpend?: () => Promise<ShadowSpend[]>;
}): H1Collection {
  const en = h1Enablement(opts.env ?? process.env);
  const now = opts.now ?? (() => new Date());
  const journal = new DecisionJournal({ root: decisionsRoot() });
  const registry = h1Registry();
  const cwd = path.join(paths.argus(), "decision-provider-cwd");
  const providers: Record<string, DecisionProvider> = {};
  // One provider per model arm. An item is assigned one arm, so arms compare
  // models between items and never double the calls.
  const arms = (en.settings?.models ?? [null]).map((model, i) => {
    const key = `claude-cli#${i}`;
    const provider = createClaudeCliProvider({
      runner: opts.runner,
      cwd,
      ...(model ? { model } : {}),
    });
    providers[key] = provider;
    return { providerKey: key, identity: () => provider.identity() };
  });
  const service = createDecisionService({
    journal,
    registry,
    builders: H1_BUILDERS,
    sources: defaultSources(),
    providers,
    now,
  });
  const ledger = new H1Ledger({ root: h1Root() });
  const watcher = createH1Watcher({
    enablement: () => en,
    ledger,
    snapshots: new H1SnapshotStore({ root: h1Root() }),
    journal,
    service: {
      async assessSnapshot(req) {
        await providerWorkdir();
        return service.assessSnapshot(req);
      },
    },
    registry,
    arms,
    sources: opts.sources ?? defaultH1Sources(),
    runner: opts.runner,
    spendBlocked: isSpendBlocked,
    ...(opts.otherSpend ? { otherSpend: opts.otherSpend } : {}),
    now,
  });
  return {
    watcher,
    status: () => statusOf(en, watcher.status()),
    spent: async () => spentFrom(await ledger.read()),
  };
}

/**
 * The H1 report and the collection's state. It reads the H1 ledger, the H1
 * snapshot store and the journal, and nothing else: no provider, no runner,
 * no live instance or gate record, and no write, not even a directory.
 */
export async function readH1ReportResponse(
  status?: () => H1CollectionStatus,
  env: Env = process.env,
): Promise<H1ReportResponse> {
  const report = await replayH1(
    new H1Ledger({ root: h1Root() }),
    new H1SnapshotStore({ root: h1Root() }),
    new DecisionJournal({ root: decisionsRoot() }),
    h1Registry(),
  );
  return { collection: status ? status() : statusOf(h1Enablement(env), null), report };
}
