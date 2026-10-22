import { useCallback } from "react";

import type { AgentSkillsInstallResponse, AgentSkillsResponse } from "@argus/contracts";
import { useLiveResource } from "./live/useLiveResource";

export type { AgentSkillsInstallResponse, AgentSkillsResponse };

const EMPTY: AgentSkillsResponse = { skills: [], upToDate: true };

/**
 * Whether the agent skills Argus ships (`argus-pipeline`, `argus-tail`) are
 * installed, and current, in the Claude Code and Codex homes on this machine —
 * and the one control that installs them. Nothing installs on its own: the
 * server only writes into an agent home when `install()` asks it to.
 */
export function useAgentSkills() {
  const { data, loading, error, refresh } = useLiveResource<AgentSkillsResponse>("/api/skills", {
    select: (j) => {
      const body = j as Partial<AgentSkillsResponse>;
      return { skills: body.skills ?? [], upToDate: body.upToDate !== false };
    },
    initial: EMPTY,
    // It changes when someone runs `argus skills install` or edits a skill:
    // rarely, and never because of anything on this page but the button.
    pollMs: 5 * 60_000,
  });

  const install = useCallback(async (): Promise<AgentSkillsInstallResponse> => {
    const res = await fetch("/api/skills/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await res.json().catch(() => ({}))) as Partial<AgentSkillsInstallResponse> & {
      error?: string;
    };
    refresh();
    // A partial failure still says what it did: the caller shows both.
    if (!res.ok && !body.results) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body as AgentSkillsInstallResponse;
  }, [refresh]);

  return { ...data, loading, error, install };
}
