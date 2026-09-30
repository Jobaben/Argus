import path from "node:path";
import type { H2CollectionStatus, H2ReportResponse } from "@argus/contracts";
import { paths } from "../../claudeHome.js";
import { isSpendBlocked } from "../../sources/budget.js";
import { readRuns } from "../../sources/runs.js";
import {
  BUILTIN_BUILDERS,
  builtinRegistry,
  decisionsRoot,
  defaultSources,
  providerWorkdir,
} from "../definitions.js";
import { DecisionJournal } from "../journal.js";
import { createClaudeCliProvider } from "../providers/claudeCli.js";
import { createDecisionService } from "../service.js";
import type { CountingRunner } from "./activity.js";
import { h2Enablement, type H2Enablement } from "./config.js";
import { CollectionLedger } from "./ledger.js";
import { replayH2 } from "./report.js";
import { createH2Watcher, type H2Watcher } from "./watcher.js";

/**
 * The only door into the Decision Plane from the rest of the server (RFC §P).
 *
 * `index.ts` wraps its one analysis runner in the pass counter and builds the
 * collection. `app.ts` reads the report. Nothing else outside the plane
 * imports the plane; the isolation test holds that.
 *
 * Building the collection touches no file. The provider's empty working
 * directory is created only just before a call, which only an enabled
 * watcher makes.
 */

export { countAnalysisPasses } from "./activity.js";

type Env = Readonly<Record<string, string | undefined>>;

/** Where the collection ledger lives: beside the journal, never inside it. */
export function h2Root(): string {
  return path.join(paths.argus(), "decision-experiments", "h2");
}

function statusOf(
  en: H2Enablement,
  watcher: H2CollectionStatus["watcher"] | null,
): H2CollectionStatus {
  const s = en.settings;
  return {
    enabled: en.enabled,
    reasons: en.enabled ? [] : en.reasons,
    settings: s
      ? {
          residualRate: s.residualRate,
          probeRate: s.probeRate,
          maxCallsPer24h: s.limits.maxCallsPer24h,
          minCallIntervalMs: s.limits.minCallIntervalMs,
          maxUsdPer24h: s.limits.maxUsdPer24h,
          requestedModel: s.model,
          seed: s.seed,
        }
      : null,
    watcher: watcher ?? {
      state: "inactive",
      detail: en.enabled ? "not started in this process" : null,
      until: null,
    },
  };
}

export interface H2Collection {
  watcher: H2Watcher;
  status(): H2CollectionStatus;
}

export function createH2Collection(opts: {
  runner: CountingRunner;
  env?: Env;
  now?: () => Date;
}): H2Collection {
  const en = h2Enablement(opts.env ?? process.env);
  const now = opts.now ?? (() => new Date());
  const journal = new DecisionJournal({ root: decisionsRoot() });
  const registry = builtinRegistry();
  const provider = createClaudeCliProvider({
    runner: opts.runner,
    cwd: path.join(paths.argus(), "decision-provider-cwd"),
    ...(en.settings?.model ? { model: en.settings.model } : {}),
  });
  const service = createDecisionService({
    journal,
    registry,
    builders: BUILTIN_BUILDERS,
    sources: defaultSources(),
    providers: { "claude-cli": provider },
    now,
  });
  const watcher = createH2Watcher({
    enablement: () => en,
    ledger: new CollectionLedger({ root: h2Root() }),
    journal,
    service: {
      async assess(req) {
        await providerWorkdir();
        return service.assess(req);
      },
    },
    registry,
    providerKey: "claude-cli",
    providerIdentity: () => provider.identity(),
    readRuns: () => readRuns(),
    runner: opts.runner,
    spendBlocked: isSpendBlocked,
    now,
  });
  return { watcher, status: () => statusOf(en, watcher.status()) };
}

/**
 * The report and the collection's state. It reads the collection ledger and
 * the journal and nothing else: no provider, no runner, no re-evaluation, and
 * no write, not even a directory.
 */
export async function readH2ReportResponse(
  status?: () => H2CollectionStatus,
  env: Env = process.env,
): Promise<H2ReportResponse> {
  const report = await replayH2(
    new CollectionLedger({ root: h2Root() }),
    new DecisionJournal({ root: decisionsRoot() }),
    builtinRegistry(),
  );
  return { collection: status ? status() : statusOf(h2Enablement(env), null), report };
}
