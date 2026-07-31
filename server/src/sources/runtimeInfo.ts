/**
 * What `GET /api/runtimes` answers: which agent CLIs this machine can drive,
 * which one is the default, and what each can and cannot do.
 *
 * The UI needs all three. A runtime picker that offers Codex on a machine
 * without it is a form that produces runs which fail at spawn, and a Budget
 * view that shows an empty cost column has to be able to say *why* it is empty
 * rather than looking broken. Both answers come from here.
 */

import { RUNTIME_IDS, RUNTIMES, defaultRuntimeId } from "../runtimes/index.js";
import { probeCommand } from "../setup/prereqs.js";
import { cached } from "./cache.js";
import type { AgentRuntimeInfo, RuntimesResponse } from "@argus/contracts";

/**
 * Probing spawns a process per runtime, and the dashboard asks on every load of
 * a form that offers the picker. A CLI does not appear on (or vanish from) PATH
 * often enough to justify that, so the answer is cached briefly — long enough to
 * collapse a burst, short enough that installing the CLI and reloading works.
 */
const PROBE_TTL_MS = 30_000;

function describe(id: (typeof RUNTIME_IDS)[number], fallbackDefault: string): AgentRuntimeInfo {
  const rt = RUNTIMES[id];
  const probe = probeCommand(rt.bin(), rt.versionArgs);
  return {
    id,
    label: rt.label,
    bin: rt.bin(),
    home: rt.home(),
    available: probe.ok,
    ...(probe.ok ? {} : { detail: `\`${rt.bin()}\` ${probe.reason}` }),
    isDefault: id === fallbackDefault,
    models: rt.models(),
    capabilities: rt.capabilities,
  };
}

export async function readRuntimes(): Promise<RuntimesResponse> {
  return cached("runtimes", PROBE_TTL_MS, async () => {
    const def = defaultRuntimeId();
    return { default: def, runtimes: RUNTIME_IDS.map((id) => describe(id, def)) };
  });
}
