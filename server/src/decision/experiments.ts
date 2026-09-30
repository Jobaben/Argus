import { createH1Collection, type H1Collection } from "./h1/entry.js";
import type { CountingRunner } from "./h2/activity.js";
import { createH2Collection, type H2Collection } from "./h2/entry.js";

/**
 * The Decision Plane's shadow experiments, run together on the scheduler tick
 * (RFC §P.4, §Q.8). `index.ts` builds them here and awaits `check()` last in
 * `onTick`.
 *
 * - H1 goes first: its items disappear when the operator acts, H2's wait up
 *   to a day.
 * - At most one provider invocation per tick across both: when H1 invoked (or
 *   may have invoked) the provider, H2 still censuses but makes no call.
 * - Each experiment checks its limits against both ledgers combined, so two
 *   experiments share one allowance instead of doubling it.
 *
 * Building them touches no file, and each is off unless its own switches are on.
 */

export { countAnalysisPasses } from "./h2/activity.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface ShadowExperiments {
  h1: H1Collection;
  h2: H2Collection;
  check(): Promise<void>;
}

export function createShadowExperiments(opts: {
  runner: CountingRunner;
  env?: Env;
  now?: () => Date;
}): ShadowExperiments {
  const holder: { h1: H1Collection | null } = { h1: null };
  const h2 = createH2Collection({
    ...opts,
    coordination: {
      otherSpend: () => (holder.h1 ? holder.h1.spent() : Promise.resolve([])),
      slotTaken: () => holder.h1?.watcher.invokedLastCheck() ?? false,
    },
  });
  const h1 = createH1Collection({ ...opts, otherSpend: () => h2.spent() });
  holder.h1 = h1;
  return {
    h1,
    h2,
    async check() {
      await h1.watcher.check();
      await h2.watcher.check();
    },
  };
}
