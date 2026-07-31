import { useEffect, useState } from "react";
import type { AgentRuntimeId, AgentRuntimeInfo, RuntimesResponse } from "./types";

/**
 * Which agent CLIs this server can drive.
 *
 * Fetched once per page load and shared: the answer changes only when someone
 * installs a CLI, and several forms (Launch, Scheduler, every pipeline phase
 * and step) ask for it at once. A module-level promise makes that one request
 * instead of a dozen, and keeps the pickers from flickering between mounts.
 */
let inflight: Promise<RuntimesResponse> | null = null;

function load(): Promise<RuntimesResponse> {
  inflight ??= fetch("/api/runtimes")
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Normalized, not trusted: this hook feeds every runtime picker, and a
      // response missing the array (an older server, a stubbed fetch) must
      // degrade to "no roster yet" rather than throwing inside a render.
      const body = (await r.json()) as Partial<RuntimesResponse> | null;
      return {
        default: body?.default === "codex" ? "codex" : "claude",
        runtimes: Array.isArray(body?.runtimes) ? body.runtimes : [],
      } satisfies RuntimesResponse;
    })
    .catch((e: unknown) => {
      // Don't cache a failure: a reload of the page, or the next mount, should
      // get another go rather than being stuck with an empty picker forever.
      inflight = null;
      throw e;
    });
  return inflight;
}

export interface RuntimesState {
  default: AgentRuntimeId;
  runtimes: AgentRuntimeInfo[];
  loading: boolean;
  error: string | null;
}

/** The runtime roster, with Claude Code assumed while the fetch is in flight —
 *  the same assumption the server makes when nothing names a runtime. */
export function useRuntimes(): RuntimesState {
  const [state, setState] = useState<RuntimesState>({
    default: "claude",
    runtimes: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let alive = true;
    load()
      .then((r) => {
        if (alive) setState({ ...r, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (alive) {
          setState((s) => ({
            ...s,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          }));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/** The display label for a runtime id, falling back to the id itself. */
export function runtimeLabel(id: AgentRuntimeId | null | undefined): string {
  if (id === "codex") return "Codex";
  if (id === "claude") return "Claude Code";
  return "";
}
