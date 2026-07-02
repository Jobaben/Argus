import { useState } from "react";
import type { PhaseDef, PhaseStep, PipelineInput } from "../types";
import { AlertStrip, TriggerFields } from "../ds";

const FIELD =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder-ink-faint";

// crypto.randomUUID is only defined in secure contexts (HTTPS or localhost).
// When Argus is served over plain HTTP on a LAN address it is undefined, so
// fall back to a non-cryptographic id — these ids are only used as local keys.
function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function newStep(): PhaseStep {
  return { name: "", prompt: "" };
}
function newPhase(): PhaseDef {
  return { id: uid(), name: "", cwd: "", gated: false, steps: [newStep()] };
}

// eslint-disable-next-line react-refresh/only-export-components -- shared blank-form constant, required alongside the component export
export const EMPTY_PIPELINE: PipelineInput = {
  name: "",
  phases: [newPhase()],
  trigger: null,
  overlapPolicy: "skip",
};

function move<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function PipelineForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: PipelineInput;
  onSubmit: (input: PipelineInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<PipelineInput>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setPhase = (i: number, patch: Partial<PhaseDef>) =>
    setForm((f) => ({ ...f, phases: f.phases.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));

  const setStep = (pi: number, si: number, patch: Partial<PhaseStep>) =>
    setForm((f) => ({
      ...f,
      phases: f.phases.map((p, j) =>
        j === pi ? { ...p, steps: p.steps.map((s, k) => (k === si ? { ...s, ...patch } : s)) } : p,
      ),
    }));

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(form);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSave =
    form.name.trim() !== "" &&
    form.phases.length > 0 &&
    form.phases.every(
      (p) =>
        p.name.trim() &&
        p.cwd.trim() &&
        p.steps.length > 0 &&
        p.steps.every((s) => s.name.trim() && s.prompt.trim()),
    );

  const iconBtn = "rounded border border-line px-2 py-0.5 text-xs text-ink-dim hover:text-ink";
  const delBtn = "rounded border border-fail/20 px-2 py-0.5 text-xs text-fail hover:bg-fail/10";

  return (
    <div className="rounded-xl border border-line bg-surface p-5 space-y-4">
      {err && <AlertStrip subject="Error" message={err} />}

      <input
        className={FIELD}
        placeholder="Pipeline name"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />

      <div className="flex flex-wrap items-center gap-2">
        <TriggerFields
          fieldClass={FIELD}
          allowManual
          value={form.trigger}
          onChange={(t) => setForm({ ...form, trigger: t })}
        />
        <select
          className={`${FIELD} w-auto`}
          value={form.overlapPolicy ?? "skip"}
          onChange={(e) => setForm({ ...form, overlapPolicy: e.target.value as "skip" | "allow" })}
        >
          <option value="skip">Skip if running</option>
          <option value="allow">Allow overlap</option>
        </select>
      </div>

      <div className="space-y-4">
        {form.phases.map((phase, pi) => (
          <div key={phase.id} className="rounded-lg border border-line bg-surface-2/40 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-faint">Phase {pi + 1}</span>
              <div className="ml-auto flex items-center gap-1">
                <button type="button" aria-label="Move phase up" className={iconBtn}
                  onClick={() => setForm((f) => ({ ...f, phases: move(f.phases, pi, pi - 1) }))}>↑</button>
                <button type="button" aria-label="Move phase down" className={iconBtn}
                  onClick={() => setForm((f) => ({ ...f, phases: move(f.phases, pi, pi + 1) }))}>↓</button>
                <button type="button" aria-label="Remove phase" className={delBtn}
                  onClick={() => setForm((f) => ({ ...f, phases: f.phases.filter((_, j) => j !== pi) }))}>✕</button>
              </div>
            </div>
            <input className={FIELD} placeholder="Phase name" value={phase.name}
              onChange={(e) => setPhase(pi, { name: e.target.value })} />
            <input className={FIELD} placeholder="Working directory (absolute path)" value={phase.cwd}
              onChange={(e) => setPhase(pi, { cwd: e.target.value })} />
            <label className="flex items-center gap-2 text-sm text-ink-dim">
              <input type="checkbox" checked={phase.gated}
                onChange={(e) => setPhase(pi, { gated: e.target.checked })} />
              Requires human approval (gated)
            </label>

            <div className="space-y-2 border-l border-line pl-3">
              {phase.steps.map((step, si) => (
                <div key={si} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <input className={`${FIELD} w-48`} placeholder="Step name" value={step.name}
                      onChange={(e) => setStep(pi, si, { name: e.target.value })} />
                    <div className="ml-auto flex items-center gap-1">
                      <button type="button" aria-label="Move step up" className={iconBtn}
                        onClick={() => setPhase(pi, { steps: move(phase.steps, si, si - 1) })}>↑</button>
                      <button type="button" aria-label="Move step down" className={iconBtn}
                        onClick={() => setPhase(pi, { steps: move(phase.steps, si, si + 1) })}>↓</button>
                      <button type="button" aria-label="Remove step" className={delBtn}
                        onClick={() => setPhase(pi, { steps: phase.steps.filter((_, k) => k !== si) })}>✕</button>
                    </div>
                  </div>
                  <textarea className={`${FIELD} h-20`} placeholder="Step prompt" value={step.prompt}
                    onChange={(e) => setStep(pi, si, { prompt: e.target.value })} />
                </div>
              ))}
              <button type="button" className={`${iconBtn} px-2.5 py-1`}
                onClick={() => setPhase(pi, { steps: [...phase.steps, newStep()] })}>+ add step</button>
            </div>
          </div>
        ))}
        <button type="button"
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-dim hover:text-ink"
          onClick={() => setForm((f) => ({ ...f, phases: [...f.phases, newPhase()] }))}>+ add phase</button>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button type="button" disabled={busy || !canSave} onClick={submit}
          className="rounded-lg bg-ok/20 px-3 py-1.5 text-sm text-ok ring-1 ring-ok/30 transition hover:bg-ok/30 disabled:opacity-50">
          {busy ? "Saving…" : "Save pipeline"}
        </button>
        <button type="button" onClick={onCancel}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-dim transition hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}
