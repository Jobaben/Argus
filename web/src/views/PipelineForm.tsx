import { useState } from "react";
import type { AgentRuntimeId, Dependency, PhaseDef, PhaseStep, PipelineInput } from "../types";
import {
  AlertStrip,
  ModelSelect,
  ReasoningEffortSelect,
  RuntimeSelect,
  TriggerFields,
} from "../ds";
import { useRuntimes } from "../useRuntimes";
import { graphColumns, graphEdges } from "./phaseGraphLayout";

/**
 * The pipeline editor as rail + focus panel.
 *
 * The form used to render every field of every phase and step at once, which
 * put a nine-phase pipeline at several screens of inputs — and still showed
 * nothing about the shape of the graph, because `needs` had no UI at all. Now
 * the rail on top is the whole pipeline at a glance — one chip per phase, laid
 * out in stages exactly like the Command Center board, gates and incomplete
 * phases marked — and the panel beneath renders the one phase being edited.
 * Nothing is lost; it is one click away instead of always on screen.
 *
 * The rail is also where dependencies became editable: the panel's
 * "starts after" toggles write `needs`, and the rail re-lays the graph as you
 * click, so a fan-out is authored by looking at the fan-out.
 */

const FIELD_BASE =
  "rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder-ink-faint";
const FIELD = `w-full ${FIELD_BASE}`;

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

/** A dependency's target phase id, whichever form the edge takes. */
const depId = (d: Dependency): string => (typeof d === "string" ? d : d.phase);

/**
 * The dependency edges in force, mirroring the server's `resolveNeeds`: if no
 * phase declares `needs` the pipeline is linear and each phase implicitly
 * needs the one before it; if any phase declares it, absent keys mean "root".
 */
function effectiveNeedIds(phases: PhaseDef[]): Map<string, string[]> {
  const declared = phases.some((p) => p.needs !== undefined);
  const out = new Map<string, string[]>();
  phases.forEach((p, i) => {
    if (declared) out.set(p.id, (p.needs ?? []).map(depId));
    else out.set(p.id, i === 0 ? [] : [phases[i - 1].id]);
  });
  return out;
}

/** The phase and everything downstream of it — the set that may not become a
 *  dependency of it, because that is exactly a cycle. */
function downstreamOf(id: string, phases: PhaseDef[]): Set<string> {
  const eff = effectiveNeedIds(phases);
  const out = new Set([id]);
  // Fixed-point instead of recursion, same as the graph layout: cheap at this
  // size, and safe against a cycle a hand-edited file might carry.
  for (let pass = 0; pass < phases.length; pass++) {
    let grew = false;
    for (const p of phases) {
      if (out.has(p.id)) continue;
      if ((eff.get(p.id) ?? []).some((d) => out.has(d))) {
        out.add(p.id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return out;
}

/** What stops this phase from being saveable, or null when nothing does. */
function phaseProblem(p: PhaseDef): string | null {
  if (!p.name.trim()) return "needs a name";
  if (!p.cwd.trim()) return "needs a working directory";
  if (p.steps.length === 0) return "needs at least one step";
  if (p.steps.some((s) => !s.name.trim() || !s.prompt.trim()))
    return "has a step missing a name or prompt";
  return null;
}

/** One phase as a rail chip: the board's visual language, edit flavour — a
 *  validity dot instead of a status dot, since nothing here has run yet. */
function EditorChip({
  phase,
  index,
  needNames,
  selected,
  onSelect,
}: {
  phase: PhaseDef;
  index: number;
  needNames: string[];
  selected: boolean;
  onSelect: () => void;
}) {
  const problem = phaseProblem(phase);
  const title = [
    `${index + 1}. ${phase.name.trim() || "unnamed"}`,
    `${phase.steps.length} step${phase.steps.length === 1 ? "" : "s"}`,
    ...(phase.gated ? ["gated: waits for a human"] : []),
    needNames.length > 0 ? `starts after ${needNames.join(", ")}` : "starts immediately",
    ...(problem ? [`incomplete: ${problem}`] : []),
  ].join(" · ");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Phase ${index + 1}: ${phase.name.trim() || "unnamed"}`}
      title={title}
      className={`flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left transition-[border-color,background-color] duration-(--duration-quick) ${
        selected
          ? "border-ink-faint bg-ground-2"
          : "border-line bg-surface hover:border-ink-faint/60 hover:bg-ground-2"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${problem ? "bg-fail" : "bg-ok"}`}
      />
      <span className="shrink-0 font-mono text-[9px] text-ink-faint">
        {String(index + 1).padStart(2, "0")}
      </span>
      <span
        className={`max-w-[10rem] truncate text-[11px] font-semibold ${
          selected ? "text-ink" : phase.name.trim() ? "text-ink-dim" : "text-ink-faint italic"
        }`}
      >
        {phase.name.trim() || "unnamed"}
      </span>
      {phase.gated && (
        <span className="shrink-0 font-mono text-[8px] font-bold uppercase tracking-[0.1em] text-await">
          gate
        </span>
      )}
      {phase.steps.length > 1 && (
        <span className="shrink-0 font-mono text-[9px] text-ink-faint">{phase.steps.length}</span>
      )}
    </button>
  );
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
  const [selectedId, setSelectedId] = useState<string | null>(initial.phases[0]?.id ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { runtimes, default: defaultRuntime } = useRuntimes();

  /** The runtime a phase/step will actually run on, narrowest override wins —
   *  the same resolution the engine does, so the model picker offers the right
   *  aliases before anything is saved. */
  const effective = (phase?: PhaseDef, step?: PhaseStep): AgentRuntimeId =>
    step?.runtime ?? phase?.runtime ?? form.runtime ?? defaultRuntime;
  const aliasesFor = (id: AgentRuntimeId) => runtimes.find((r) => r.id === id)?.models;
  const effortsFor = (id: AgentRuntimeId) =>
    runtimes.find((r) => r.id === id)?.reasoningEfforts ?? [];

  const setPhase = (i: number, patch: Partial<PhaseDef>) =>
    setForm((f) => ({ ...f, phases: f.phases.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));

  const setStep = (pi: number, si: number, patch: Partial<PhaseStep>) =>
    setForm((f) => ({
      ...f,
      phases: f.phases.map((p, j) =>
        j === pi ? { ...p, steps: p.steps.map((s, k) => (k === si ? { ...s, ...patch } : s)) } : p,
      ),
    }));

  const addPhase = () => {
    const p = newPhase();
    if (form.phases.some((x) => x.needs !== undefined)) {
      // An explicit graph: the new phase joins after everything, i.e. after
      // the current leaves — the same place "+ add phase" puts it visually.
      const dependedOn = new Set([...effectiveNeedIds(form.phases).values()].flat());
      p.needs = form.phases.filter((x) => !dependedOn.has(x.id)).map((x) => x.id);
    }
    // A linear pipeline stays linear by *not* declaring needs at all, so a
    // definition authored before Weave keeps its implicit-edge reading.
    setForm((f) => ({ ...f, phases: [...f.phases, p] }));
    setSelectedId(p.id);
  };

  const removePhase = (i: number) => {
    const dead = form.phases[i].id;
    const rest = form.phases.filter((_, j) => j !== i);
    // Strip edges into the removed phase, or the graph fails validation with
    // a dangling dependency the form gives no way to see.
    const phases = rest.map((p) =>
      p.needs === undefined ? p : { ...p, needs: p.needs.filter((d) => depId(d) !== dead) },
    );
    if (selectedId === dead) setSelectedId(phases[Math.min(i, phases.length - 1)]?.id ?? null);
    setForm((f) => ({ ...f, phases }));
  };

  /** Flip one dependency edge. First edit of a linear pipeline materializes the
   *  implicit edges on every phase, so going explicit does not reshape the
   *  graph — absent `needs` means "previous phase" before, "root" after. */
  const toggleNeed = (phaseId: string, dep: string) =>
    setForm((f) => {
      const declared = f.phases.some((p) => p.needs !== undefined);
      const eff = effectiveNeedIds(f.phases);
      return {
        ...f,
        phases: f.phases.map((p) => {
          // Preserve object-form edges (conditions authored by hand or via the
          // API) verbatim on every edge the click did not touch.
          const cur: Dependency[] = p.needs ?? eff.get(p.id) ?? [];
          if (p.id !== phaseId) return declared ? p : { ...p, needs: cur };
          const has = cur.some((d) => depId(d) === dep);
          return { ...p, needs: has ? cur.filter((d) => depId(d) !== dep) : [...cur, dep] };
        }),
      };
    });

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      // autoApprove without a gate is a validation error server-side; dropping
      // it here is what un-checking "gated" means for it.
      await onSubmit({
        ...form,
        phases: form.phases.map((p) => {
          if (p.gated || p.autoApprove === undefined) return p;
          const { autoApprove: _dropped, ...rest } = p;
          return rest;
        }),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const problems = form.phases.map(phaseProblem);
  const canSave = form.name.trim() !== "" && form.phases.length > 0 && problems.every((p) => !p);

  const iconBtn = "rounded border border-line px-2 py-0.5 text-xs text-ink-dim hover:text-ink";
  const delBtn = "rounded border border-fail/20 px-2 py-0.5 text-xs text-fail hover:bg-fail/10";

  const effIds = effectiveNeedIds(form.phases);
  const nameOf = new Map(form.phases.map((p) => [p.id, p.name.trim() || "unnamed"]));
  const indexOf = new Map(form.phases.map((p, i) => [p.id, i]));
  const nodes = form.phases.map((p) => ({ id: p.id, needs: effIds.get(p.id) ?? [], def: p }));
  // A single-phase pipeline has no edges; graphColumns would still put it in
  // one column, so the fallback only matters for reading clarity.
  const columns =
    graphEdges(nodes).length > 0
      ? graphColumns(nodes)
      : nodes.map((n, i) => ({ depth: i, phases: [n] }));

  const pi = selectedId ? (indexOf.get(selectedId) ?? -1) : -1;
  const phase = pi === -1 ? null : form.phases[pi];

  return (
    <div className="rounded-xl border border-line bg-surface p-5 space-y-4">
      {err && <AlertStrip subject="Error" message={err} />}

      {/* ── The pipeline: name, save, schedule and defaults ─────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${FIELD_BASE} min-w-56 flex-1`}
          aria-label="Pipeline name"
          placeholder="Pipeline name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <button
          type="button"
          disabled={busy || !canSave}
          onClick={submit}
          title={
            canSave
              ? undefined
              : "Requires a pipeline name and, per phase: a name, a working directory, and at least one step with a name and prompt"
          }
          className="rounded-lg bg-ok/20 px-3 py-1.5 text-sm text-ok ring-1 ring-ok/30 transition hover:bg-ok/30 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save pipeline"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-dim transition hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TriggerFields
          fieldClass={FIELD_BASE}
          allowManual
          allowWindowed
          value={form.trigger}
          onChange={(t) => setForm({ ...form, trigger: t })}
        />
        <select
          className={FIELD_BASE}
          aria-label="Overlap policy"
          value={form.overlapPolicy ?? "skip"}
          onChange={(e) => setForm({ ...form, overlapPolicy: e.target.value as "skip" | "allow" })}
        >
          <option value="skip">Skip if running</option>
          <option value="allow">Allow overlap</option>
        </select>
        <RuntimeSelect
          fieldClass={FIELD_BASE}
          label="Runtime (server default)"
          value={form.runtime}
          runtimes={runtimes}
          onChange={(r) =>
            setForm({ ...form, runtime: r, model: undefined, reasoningEffort: undefined })
          }
        />
        <ReasoningEffortSelect
          key={`pipeline-effort:${effective()}`}
          fieldClass={FIELD_BASE}
          label="Default effort (inherit CLI)"
          value={form.reasoningEffort}
          efforts={effortsFor(effective())}
          onChange={(reasoningEffort) => setForm({ ...form, reasoningEffort })}
        />
        <ModelSelect
          key={`pipeline:${effective()}`}
          fieldClass={FIELD_BASE}
          label="Default model (inherit CLI)"
          value={form.model}
          {...(aliasesFor(effective()) ? { aliases: aliasesFor(effective()) } : {})}
          onChange={(m) => setForm({ ...form, model: m })}
        />
      </div>

      {/* ── The rail: every phase, in stages, always on screen ──────────── */}
      <div className="rounded-lg border border-line bg-ground-2/60 p-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint">
            Phases
          </span>
          <span className="text-[11px] text-ink-faint">
            select one to edit it below — phases in the same column start together
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
          <ol aria-label="Phases" className="contents">
            {columns.map((col, i) => (
              <li key={col.depth} className="flex min-w-0 items-center gap-1.5">
                {i > 0 && (
                  <span aria-hidden="true" className="font-mono text-[10px] text-ink-faint">
                    →
                  </span>
                )}
                {/* A stage with several phases stacks them, so a fan-out reads
                    vertically between the arrows — the graph, at chip size. */}
                <ol className="flex min-w-0 flex-col gap-1">
                  {col.phases.map((n) => (
                    <li key={n.id} className="min-w-0">
                      <EditorChip
                        phase={n.def}
                        index={indexOf.get(n.id) ?? 0}
                        needNames={(effIds.get(n.id) ?? []).map((d) => nameOf.get(d) ?? d)}
                        selected={n.id === selectedId}
                        onSelect={() => setSelectedId(n.id)}
                      />
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
          <button type="button" className={`${iconBtn} px-2.5 py-1`} onClick={addPhase}>
            + add phase
          </button>
        </div>
      </div>

      {/* ── The focus panel: the one phase being edited ─────────────────── */}
      {phase && (
        <div
          // Keyed per phase so moving the focus is visible as a change — the
          // incoming panel plays the same entrance as the board's focus panel;
          // reduced motion resolves instantly via the global kill switch.
          key={phase.id}
          className="rounded-lg border border-line bg-surface-2/40 p-4 space-y-3 motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-faint">
              Phase {pi + 1}
              <span className="text-ink-faint/60"> of {form.phases.length}</span>
            </span>
            {problems[pi] && <span className="text-xs text-fail">{problems[pi]}</span>}
            {/* Features authored via the API ride along untouched; saying so
                beats a silent field the form appears not to know about. */}
            {phase.retry && (
              <span
                className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint"
                title={`Retries failed steps: ${phase.retry.attempts} attempts, ${phase.retry.backoffSeconds}s backoff (set via the API; preserved on save)`}
              >
                retry ×{phase.retry.attempts}
              </span>
            )}
            {phase.produces && (
              <span
                className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint"
                title={`Publishes its payload as {{artifacts.${phase.produces}}} (set via the API; preserved on save)`}
              >
                → {phase.produces}
              </span>
            )}
            {phase.rubric && (
              <span
                className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint"
                title="Carries a quality rubric (set via the API; preserved on save)"
              >
                rubric
              </span>
            )}
            {phase.autoApprove && (
              <span
                className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint"
                title="The gate opens itself when the verdict clears the bar (set via the API; preserved on save)"
              >
                auto-approve
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                aria-label="Move phase up"
                title="Move earlier in declaration order"
                className={iconBtn}
                onClick={() => setForm((f) => ({ ...f, phases: move(f.phases, pi, pi - 1) }))}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Move phase down"
                title="Move later in declaration order"
                className={iconBtn}
                onClick={() => setForm((f) => ({ ...f, phases: move(f.phases, pi, pi + 1) }))}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label="Remove phase"
                className={delBtn}
                onClick={() => removePhase(pi)}
              >
                ✕
              </button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className={FIELD}
              aria-label={`Phase ${pi + 1} name`}
              placeholder="Phase name"
              value={phase.name}
              onChange={(e) => setPhase(pi, { name: e.target.value })}
            />
            <input
              className={FIELD}
              aria-label={`Phase ${pi + 1} working directory`}
              placeholder="Working directory (absolute path)"
              value={phase.cwd}
              onChange={(e) => setPhase(pi, { cwd: e.target.value })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink-dim">
              <input
                type="checkbox"
                checked={phase.gated}
                onChange={(e) => setPhase(pi, { gated: e.target.checked })}
              />
              Requires human approval (gated)
            </label>
            <RuntimeSelect
              fieldClass={FIELD_BASE}
              label="Use pipeline runtime"
              ariaLabel={`Runtime (phase ${pi + 1})`}
              value={phase.runtime}
              runtimes={runtimes}
              onChange={(r) => setPhase(pi, { runtime: r })}
            />
          </div>

          {form.phases.length > 1 && (
            <div className="space-y-1.5">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint">
                Starts after
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {form.phases.map((other, oi) => {
                  if (other.id === phase.id) return null;
                  const on = (effIds.get(phase.id) ?? []).includes(other.id);
                  // Everything downstream of this phase is off the menu: an
                  // edge back into it is exactly a cycle.
                  const cycle = !on && downstreamOf(phase.id, form.phases).has(other.id);
                  return (
                    <button
                      key={other.id}
                      type="button"
                      aria-pressed={on}
                      aria-label={`Starts after phase ${oi + 1}: ${other.name.trim() || "unnamed"}`}
                      disabled={cycle}
                      title={
                        cycle
                          ? `"${nameOf.get(other.id)}" already runs after this phase — depending on it would create a cycle`
                          : undefined
                      }
                      className={`rounded-md border px-2 py-0.5 text-[11px] transition-[border-color,background-color] duration-(--duration-quick) ${
                        on
                          ? "border-ink-faint bg-ground-2 text-ink"
                          : "border-line text-ink-dim hover:text-ink disabled:opacity-40 disabled:hover:text-ink-dim"
                      }`}
                      onClick={() => toggleNeed(phase.id, other.id)}
                    >
                      {nameOf.get(other.id)}
                    </button>
                  );
                })}
                {(effIds.get(phase.id) ?? []).length === 0 && (
                  <span className="text-[11px] text-ink-faint">
                    nothing — this phase starts immediately
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="space-y-2 border-l border-line pl-3">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint">
              Steps
            </span>
            {phase.steps.map((step, si) => (
              <div key={si} className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${FIELD_BASE} w-48`}
                    aria-label={`Phase ${pi + 1} step ${si + 1} name`}
                    placeholder="Step name"
                    value={step.name}
                    onChange={(e) => setStep(pi, si, { name: e.target.value })}
                  />
                  <RuntimeSelect
                    fieldClass={FIELD_BASE}
                    label="Use phase runtime"
                    ariaLabel={`Runtime (phase ${pi + 1} step ${si + 1})`}
                    value={step.runtime}
                    runtimes={runtimes}
                    onChange={(r) =>
                      setStep(pi, si, {
                        runtime: r,
                        model: undefined,
                        reasoningEffort: undefined,
                      })
                    }
                  />
                  <ReasoningEffortSelect
                    key={`step-effort:${pi}:${si}:${effective(phase, step)}`}
                    fieldClass={FIELD_BASE}
                    label="Use pipeline effort"
                    ariaLabel={`Use pipeline effort (phase ${pi + 1} step ${si + 1})`}
                    value={step.reasoningEffort}
                    efforts={effortsFor(effective(phase, step))}
                    onChange={(reasoningEffort) => setStep(pi, si, { reasoningEffort })}
                  />
                  <ModelSelect
                    key={`step:${pi}:${si}:${effective(phase, step)}`}
                    fieldClass={FIELD_BASE}
                    label="Use pipeline default"
                    ariaLabel={`Use pipeline default (phase ${pi + 1} step ${si + 1})`}
                    value={step.model}
                    {...(aliasesFor(effective(phase, step))
                      ? { aliases: aliasesFor(effective(phase, step)) }
                      : {})}
                    onChange={(m) => setStep(pi, si, { model: m })}
                  />
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      aria-label="Move step up"
                      className={iconBtn}
                      onClick={() => setPhase(pi, { steps: move(phase.steps, si, si - 1) })}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Move step down"
                      className={iconBtn}
                      onClick={() => setPhase(pi, { steps: move(phase.steps, si, si + 1) })}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label="Remove step"
                      className={delBtn}
                      onClick={() =>
                        setPhase(pi, { steps: phase.steps.filter((_, k) => k !== si) })
                      }
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <textarea
                  className={`${FIELD} h-20`}
                  aria-label={`Phase ${pi + 1} step ${si + 1} prompt`}
                  placeholder="Step prompt"
                  value={step.prompt}
                  onChange={(e) => setStep(pi, si, { prompt: e.target.value })}
                />
              </div>
            ))}
            <button
              type="button"
              className={`${iconBtn} px-2.5 py-1`}
              onClick={() => setPhase(pi, { steps: [...phase.steps, newStep()] })}
            >
              + add step
            </button>
          </div>
        </div>
      )}

      <p className="max-w-prose text-xs text-ink-faint">
        A phase or a single step can override the runtime, so one pipeline can draft on one agent
        and review on the other. Each step's run records which CLI produced it.
        {!canSave && !busy && (
          <span>
            {" "}
            Name the pipeline and complete every phase — an incomplete phase carries a red dot in
            the rail above.
          </span>
        )}
      </p>
    </div>
  );
}
