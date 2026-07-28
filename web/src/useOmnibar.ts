import { useCallback, useState } from "react";
import type { ExecuteResult, OmnibarAnswer, Plan } from "./types";

/**
 * The Omnibar's client half: plan, read, confirm.
 *
 * Two calls rather than one, and the state machine keeps them honest. A plan
 * lives here until it is confirmed or dropped; the confirm sends only its id,
 * so the sentence is never re-interpreted, and what runs is what was on screen.
 */

export type OmnibarPhase = "idle" | "planning" | "preview" | "answered" | "executing" | "done";

export interface OmnibarState {
  phase: OmnibarPhase;
  plan: Plan | null;
  answer: OmnibarAnswer | null;
  result: ExecuteResult | null;
  error: string | null;
}

const IDLE: OmnibarState = { phase: "idle", plan: null, answer: null, result: null, error: null };

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(
      json.error ?? (res.status === 401 ? "sign in to use this" : `HTTP ${res.status}`),
    );
  }
  return json;
}

export function useOmnibar() {
  const [state, setState] = useState<OmnibarState>(IDLE);

  const reset = useCallback(() => setState(IDLE), []);

  // Named `compile`, not `plan`: the noun is already `state.plan`, and a hook
  // that returns both under one name makes every destructure a shadowing bug.
  const compile = useCallback(async (intent: string) => {
    setState({ ...IDLE, phase: "planning" });
    try {
      const res = await post<{ mode: string; plan: Plan | null; answer: OmnibarAnswer | null }>(
        "/api/omnibar/plan",
        { intent },
      );
      if (res.mode === "answer" && res.answer) {
        setState({ ...IDLE, phase: "answered", answer: res.answer });
        return;
      }
      setState({ ...IDLE, phase: "preview", plan: res.plan });
    } catch (e) {
      setState({ ...IDLE, error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const confirm = useCallback(async (planId: string) => {
    setState((s) => ({ ...s, phase: "executing", error: null }));
    try {
      const result = await post<ExecuteResult>("/api/omnibar/execute", { planId });
      setState((s) => ({ ...s, phase: "done", result }));
    } catch (e) {
      setState((s) => ({
        ...s,
        // Back to the preview, not to done: a confirm that never reached the
        // server has changed nothing, and the plan is still the plan.
        phase: "preview",
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, []);

  return { ...state, compile, confirm, reset };
}
