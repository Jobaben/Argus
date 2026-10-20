import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  AgentRuntimeId,
  AgentRuntimeInfo,
  CandidatePolicy,
  CandidateVariant,
  Dependency,
  PhaseDef,
  PhaseStep,
  PipelineInput,
  WorkspacePolicy,
} from "../types";
import {
  AlertStrip,
  Button,
  buttonClass,
  chipClass,
  fieldClass,
  Icon,
  IconButton,
  labelClass,
} from "../ds";
import { TriggerFields } from "../ds/TriggerFields";
import { useRuntimes } from "../useRuntimes";
import { graphColumns, graphEdges } from "./phaseGraphLayout";
import { EdgeConditions, ResultEditor } from "./PipelineRoutes";
import { ModelSelect } from "../ds/ModelSelect";
import { ReasoningEffortSelect } from "../ds/ReasoningEffortSelect";
import { RuntimeSelect } from "../ds/RuntimeSelect";

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
 *
 * Inside the panel the order is the order of importance: what the phase is
 * (name, directory, whether a human signs it off), then what it does (its
 * steps and their prompts), and only then the wiring and the tuning. The
 * prompts used to come last, after routing and candidates, in a box three lines
 * tall.
 */

/** A text input or a select of our own: full width of its field. */
const FIELD = `${fieldClass} h-9 w-full`;
/** For the shared runtime/model/effort pickers, which take their visible name
 *  as `caption` and fill their column themselves. */
const PICKER = `${fieldClass} h-9`;
/** A pressable chip — a rail phase, a "starts after" toggle — in the button
 *  language: the ghost anatomy (press feedback, disabled convention) on a
 *  quiet surface, lit in the selection colour while pressed. The border colour
 *  is the caller's, so a draft can say it is one. */
const TOGGLE = buttonClass(
  "ghost",
  "md",
  "max-w-full border bg-surface hover:border-ink-faint/60 aria-pressed:border-solid aria-pressed:border-eye/55 aria-pressed:bg-eye/[0.08] aria-pressed:text-ink",
);
/** The pipeline's own name: the title of what is being edited, set like one. */
const NAME_FIELD = `${fieldClass.replace("text-small", "text-title font-semibold")} h-11 w-full`;
/** A prompt is prose, and the thing the reader came to write. */
const PROMPT_FIELD = `${fieldClass.replace("text-small", "text-body")} min-h-40 w-full resize-y leading-relaxed`;

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

/**
 * A field with its name above it.
 *
 * Every select here used to carry its name only as its empty option — "Runtime
 * (server default)", "Use pipeline isolation" — so the moment a value was
 * picked ("Codex", "Skip if running") nothing on screen said what the control
 * was. The aria-labels the controls already have stay their accessible names;
 * this is the name for the eye. `plain` renders the name without a `<label>`,
 * for a group of controls (the trigger) or a name that would collide with
 * another control's accessible name (the phase's isolation, which would
 * otherwise answer to "Isolation" alongside the pipeline's).
 */
function Field({
  label,
  hint,
  plain = false,
  className = "",
  children,
}: {
  label: string;
  hint?: ReactNode;
  plain?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className={labelClass}>{label}</span>
      {children}
      {hint && <span className="text-caption text-ink-faint">{hint}</span>}
    </>
  );
  const cls = `flex min-w-0 flex-col gap-1.5 ${className}`;
  return plain ? <div className={cls}>{body}</div> : <label className={cls}>{body}</label>;
}

/** The form's one section idiom: an eyebrow, then an inset well — set apart by
 *  its tone, not by another outline inside the panel's. */
function FormSection({
  title,
  hint,
  flush = false,
  children,
}: {
  title: string;
  hint?: ReactNode;
  /** The well's children manage their own padding (the rail + panel pair). */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="eyebrow">{title}</h3>
        {hint && <p className="text-caption text-ink-faint">{hint}</p>}
      </div>
      <div className={`min-w-0 rounded-tile bg-ground-2/60 ${flush ? "" : "p-3 sm:p-4"}`}>
        {children}
      </div>
    </section>
  );
}

/** A part of the phase panel: a heading, a line on what it is for, its fields. */
function PanelPart({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 border-t border-line pt-5">
      <div className="mb-3">
        <h4 className="text-heading font-semibold text-ink">{title}</h4>
        {hint && <p className="mt-0.5 text-caption text-ink-faint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * Isolation, as the form writes it.
 *
 * `""` means "no policy here": the key is removed rather than set to
 * undefined, so a pipeline (or phase) that never asked for a worktree
 * round-trips exactly as it was authored. `base` and `keep` are API-only
 * fields — the form preserves whatever they hold and only ever moves `scope`.
 */
type IsolationChoice = "" | WorkspacePolicy["scope"];

function withWorkspace<T extends { workspace?: WorkspacePolicy }>(
  target: T,
  scope: IsolationChoice,
): T {
  if (!scope) {
    const { workspace: _dropped, ...rest } = target;
    return rest as T;
  }
  return { ...target, workspace: { ...(target.workspace ?? {}), scope } };
}

/** The isolation control, in the same visual language as the other selects. */
function IsolationSelect({
  fieldClass,
  ariaLabel,
  inheritLabel,
  value,
  onChange,
}: {
  fieldClass: string;
  ariaLabel: string;
  /** What an absent policy means here: the pipeline's default, or none at all. */
  inheritLabel: string;
  value: WorkspacePolicy | undefined;
  onChange: (scope: IsolationChoice) => void;
}) {
  return (
    <select
      className={fieldClass}
      aria-label={ariaLabel}
      title="Run the steps in a git worktree of the repository at the working directory. The branch is kept; the directory is removed when the instance ends."
      value={value?.scope ?? ""}
      onChange={(e) => onChange(e.target.value as IsolationChoice)}
    >
      <option value="">{inheritLabel}</option>
      <option value="instance">Shared worktree per instance</option>
      <option value="attempt">Fresh worktree per attempt</option>
      <option value="none">None (opt out, run in the working directory)</option>
    </select>
  );
}

/**
 * Best-of-N, as the form writes it.
 *
 * Two requirements the server enforces are enforced here too, by disabling the
 * control rather than by letting a save fail: a candidates phase must have
 * exactly one step (a selection replaces the whole phase's result with one
 * candidate's), and it must run under attempt-scoped isolation (without a
 * worktree each, the candidates are not samples of the same task — they are N
 * agents editing one checkout). The reason is stated inline, because a greyed
 * control that does not say why is a bug report waiting to happen.
 */
function CandidateFields({
  phase,
  index,
  pipelineWorkspace,
  runtimes,
  aliasesFor,
  effective,
  onChange,
}: {
  phase: PhaseDef;
  index: number;
  pipelineWorkspace: WorkspacePolicy | undefined;
  runtimes: AgentRuntimeInfo[];
  aliasesFor: (id: AgentRuntimeId) => string[] | undefined;
  effective: (phase?: PhaseDef, step?: PhaseStep) => AgentRuntimeId;
  onChange: (patch: Partial<PhaseDef>) => void;
}) {
  const scope = (phase.workspace ?? pipelineWorkspace)?.scope;
  const blockers: string[] = [];
  if (phase.steps.length !== 1) blockers.push("the phase must have exactly one step");
  if (scope !== "attempt") blockers.push('isolation must be "Fresh worktree per attempt"');
  const allowed = blockers.length === 0;
  const policy = phase.candidates;
  const dense = `${fieldClass} h-8 flex-1`;

  const write = (next: CandidatePolicy | undefined) => onChange({ candidates: next });
  const setVariant = (i: number, patch: CandidateVariant) => {
    if (!policy) return;
    const variants = Array.from(
      { length: policy.count },
      (_, k) => policy.variants?.[k] ?? ({} as CandidateVariant),
    );
    const merged = { ...variants[i], ...patch };
    // An emptied variant is removed rather than kept as `{}`: cycling over
    // variants is only meaningful for entries that say something.
    variants[i] = Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v !== undefined),
    ) as CandidateVariant;
    const trimmed = variants.slice(
      0,
      variants.reduce((last, v, k) => (Object.keys(v).length > 0 ? k + 1 : last), 0),
    );
    write({ ...policy, ...(trimmed.length > 0 ? { variants: trimmed } : { variants: undefined }) });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Candidates">
          <select
            className={FIELD}
            disabled={!allowed}
            aria-label={`Candidates (phase ${index + 1})`}
            title="Run this step several times at once and let the phase's checks pick the winner."
            value={policy ? String(policy.count) : ""}
            onChange={(e) =>
              write(
                e.target.value === ""
                  ? undefined
                  : {
                      ...(policy ?? { select: "first-verified" as const }),
                      count: Number(e.target.value),
                    },
              )
            }
          >
            <option value="">Off — one run of this step</option>
            {[2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n} candidates
              </option>
            ))}
          </select>
        </Field>
        {policy && (
          <Field label="Winner">
            <select
              className={FIELD}
              aria-label={`Candidate selection (phase ${index + 1})`}
              value={policy.select}
              onChange={(e) =>
                write({ ...policy, select: e.target.value as CandidatePolicy["select"] })
              }
            >
              <option value="first-verified">First verified wins (kill the rest)</option>
              <option value="cheapest-verified">Cheapest verified wins (run all)</option>
            </select>
          </Field>
        )}
      </div>
      {!allowed && (
        <p className="flex items-start gap-1.5 text-caption text-ink-faint">
          <Icon name="info" size={14} className="mt-px" />
          <span>Candidates can't be turned on yet: {blockers.join(", and ")}.</span>
        </p>
      )}
      {policy && (
        <div className="space-y-2 rounded-control bg-surface/70 p-3">
          <p className="text-caption text-ink-faint">
            Each candidate gets its own worktree and artifact directory. Leave a row blank to run
            the step exactly as declared; naming a runtime drafts the same step on two CLIs and lets
            the checks choose.
          </p>
          {Array.from({ length: policy.count }, (_, i) => {
            const variant = policy.variants?.[i] ?? {};
            const runtime = variant.runtime ?? effective(phase, phase.steps[0]);
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-7 shrink-0 text-caption font-semibold text-ink-faint">
                  c{i + 1}
                </span>
                <div className="min-w-[10rem] flex-1">
                  <RuntimeSelect
                    fieldClass={dense}
                    label="Use step runtime"
                    ariaLabel={`Candidate ${i + 1} runtime (phase ${index + 1})`}
                    value={variant.runtime}
                    runtimes={runtimes}
                    onChange={(r) => setVariant(i, { runtime: r, model: undefined })}
                  />
                </div>
                <div className="min-w-[10rem] flex-1">
                  <ModelSelect
                    key={`candidate:${index}:${i}:${runtime}`}
                    fieldClass={dense}
                    label="Use step model"
                    ariaLabel={`Candidate ${i + 1} model (phase ${index + 1})`}
                    value={variant.model}
                    {...(aliasesFor(runtime) ? { aliases: aliasesFor(runtime) } : {})}
                    onChange={(m) => setVariant(i, { model: m })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
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
 *  completeness mark instead of a status dot, since nothing here has run yet.
 *  An incomplete phase is a draft, not a failure, so it is drawn as one (a
 *  hollow mark, a dashed edge) rather than in the colour that means "failed". */
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
      // A draft keeps the dashed edge until it is selected, when the selection
      // colour takes over the whole border.
      className={`${TOGGLE} ${problem ? "border-dashed border-line-strong" : "border-line"}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          problem ? "border border-ink-faint" : "bg-ok"
        }`}
      />
      <span className="shrink-0 text-micro font-normal text-ink-faint">
        {String(index + 1).padStart(2, "0")}
      </span>
      <span
        className={`min-w-0 max-w-[11rem] truncate text-caption font-semibold ${
          selected ? "text-ink" : phase.name.trim() ? "text-ink-dim" : "italic text-ink-faint"
        }`}
      >
        {phase.name.trim() || "unnamed"}
      </span>
      {phase.gated && <span className={chipClass("await")}>gate</span>}
      {phase.steps.length > 1 && (
        <span className="shrink-0 text-micro font-normal text-ink-faint">{phase.steps.length}</span>
      )}
    </button>
  );
}

export function PipelineForm({
  initial,
  onSubmit,
  onCancel,
  pipelines = [],
  pipelineId,
  hookToken,
  onRotateHook,
  autoFocus = false,
}: {
  initial: PipelineInput;
  onSubmit: (input: PipelineInput) => Promise<void>;
  onCancel: () => void;
  /** Every other pipeline, for the "after pipeline" trigger's source select
   *  (this one is excluded to keep a self-chain from ever being offered). */
  pipelines?: { id: string; name: string }[];
  /** This pipeline's own id, once saved — undefined while authoring a new one. */
  pipelineId?: string;
  /** Set once this pipeline has a webhook trigger and has been saved at least
   *  once (the save that mints the token). */
  hookToken?: string;
  onRotateHook?: () => Promise<void>;
  /** Put the caret in the name as the form opens — for a form that replaces
   *  the control that opened it, which takes keyboard focus with it. */
  autoFocus?: boolean;
}) {
  const [form, setForm] = useState<PipelineInput>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial.phases[0]?.id ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { runtimes, default: defaultRuntime } = useRuntimes();
  const hintId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  // Once, as it opens: after that the caret is wherever the author puts it.
  useEffect(() => {
    if (autoFocus) nameRef.current?.focus();
  }, [autoFocus]);

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
      // the current leaves — the same place "Add phase" puts it visually.
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
  // Why Save is greyed, in words beside it. It used to be a tooltip on a
  // disabled button — which most browsers never show, because a disabled
  // button receives no hover.
  const missing = [
    ...(form.name.trim() ? [] : ["name the pipeline"]),
    ...(form.phases.length === 0 ? ["add a phase"] : []),
    ...problems.flatMap((p, i) => {
      if (!p) return [];
      const name = form.phases[i].name.trim();
      return [`phase ${i + 1}${name ? ` (${name})` : ""} ${p}`];
    }),
  ];

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
  const pipelineEfforts = effortsFor(effective());

  return (
    <div className="min-w-0 space-y-6 rounded-panel border border-line-strong bg-surface p-3 shadow-raised sm:p-6">
      {/* ── What is being edited, and the way out of it ─────────────────── */}
      <div>
        <h2 className="eyebrow mb-2">{pipelineId ? "Edit pipeline" : "New pipeline"}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <input
            ref={nameRef}
            className={`${NAME_FIELD} min-w-0 flex-1 basis-64`}
            aria-label="Pipeline name"
            placeholder="Pipeline name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="lg" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="lg"
              icon="check"
              disabled={busy || !canSave}
              onClick={submit}
              aria-describedby={canSave ? undefined : hintId}
            >
              {busy ? "Saving…" : "Save pipeline"}
            </Button>
          </div>
        </div>
        {!canSave && !busy && (
          <p
            id={hintId}
            className="mt-2 flex items-start gap-1.5 text-caption text-ink-faint"
            aria-live="polite"
          >
            <Icon name="info" size={14} className="mt-px shrink-0" />
            <span className="min-w-0">{`Before it can be saved: ${missing.join(" · ")}.`}</span>
          </p>
        )}
        {err && (
          <div className="mt-3">
            <AlertStrip subject="Couldn't save" message={err} />
          </div>
        )}
      </div>

      {/* ── The pipeline: schedule and defaults ─────────────────────────── */}
      <FormSection
        title="Pipeline settings"
        hint="Phases and steps can override the runtime and model, so one pipeline can draft on one agent and review on another."
      >
        {/* When it fires, then what every phase runs on unless it says otherwise. */}
        <div className="flex flex-wrap items-start gap-4">
          <Field label="Trigger" plain className="max-w-full">
            <TriggerFields
              fieldClass={`${fieldClass} h-9`}
              allowManual
              allowWindowed
              value={form.trigger}
              onChange={(t) => setForm({ ...form, trigger: t })}
              pipelines={pipelines.filter((p) => p.id !== pipelineId)}
              hook={
                hookToken && pipelineId && onRotateHook
                  ? {
                      url: `${window.location.origin}/api/hooks/pipelines/${pipelineId}`,
                      token: hookToken,
                      onRotate: onRotateHook,
                    }
                  : undefined
              }
            />
          </Field>
          <Field label="If already running" className="w-full sm:w-56">
            <select
              className={FIELD}
              aria-label="Overlap policy"
              value={form.overlapPolicy ?? "skip"}
              onChange={(e) =>
                setForm({ ...form, overlapPolicy: e.target.value as "skip" | "allow" })
              }
            >
              <option value="skip">Skip if running</option>
              <option value="allow">Allow overlap</option>
            </select>
          </Field>
        </div>
        <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2 xl:grid-cols-4">
          <RuntimeSelect
            caption="Runtime"
            fieldClass={PICKER}
            label="Runtime (server default)"
            value={form.runtime}
            runtimes={runtimes}
            onChange={(r) =>
              setForm({ ...form, runtime: r, model: undefined, reasoningEffort: undefined })
            }
          />
          {/* The runtime decides whether there is an effort to choose at all
              (Claude Code has none); the picker renders nothing, caption and
              all, when there is not, so the grid closes up. */}
          <ReasoningEffortSelect
            key={`pipeline-effort:${effective()}`}
            caption="Effort"
            fieldClass={PICKER}
            label="Default effort (inherit CLI)"
            value={form.reasoningEffort}
            efforts={pipelineEfforts}
            onChange={(reasoningEffort) => setForm({ ...form, reasoningEffort })}
          />
          {/* A custom model id stacks under the picker rather than sharing its
              row, where a phone clipped the id mid-word. */}
          <ModelSelect
            key={`pipeline:${effective()}`}
            caption="Model"
            fieldClass={PICKER}
            label="Default model (inherit CLI)"
            value={form.model}
            {...(aliasesFor(effective()) ? { aliases: aliasesFor(effective()) } : {})}
            onChange={(m) => setForm({ ...form, model: m })}
          />
          <Field label="Isolation">
            <IsolationSelect
              fieldClass={FIELD}
              ariaLabel="Isolation"
              inheritLabel="No isolation (phase working directory)"
              value={form.workspace}
              onChange={(scope) => setForm((f) => withWorkspace(f, scope))}
            />
          </Field>
        </div>
      </FormSection>

      {/* ── The rail, and the one phase being edited beneath it ─────────── */}
      <FormSection
        title="Phases"
        hint="Select a phase to edit it. Phases in the same column start together."
        flush
      >
        {/* MetaLine's trick, at chip size: every stage carries its own leading
            arrow, and the row sits one arrow's width to the left inside a
            clipping box — so the stage that starts a line, the first or one that
            wrapped, has its arrow clipped away instead of dangling as an indent.
            The clipping box keeps a hair of padding for the focus ring. */}
        <div className="p-2 sm:p-3">
          <div className="overflow-hidden p-1">
            <div className="-ml-6 flex flex-wrap items-center gap-y-2">
              <ol aria-label="Phases" className="contents">
                {columns.map((col) => (
                  <li
                    key={col.depth}
                    className="relative flex min-w-0 max-w-full items-center pl-6"
                  >
                    <Icon
                      name="chevron-right"
                      size={14}
                      className="absolute left-[5px] top-1/2 -translate-y-1/2 text-ink-faint/70"
                    />
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
              {/* No arrow — it is not a stage — but the same inset, so a wrapped
                  Add phase lines up with the chips rather than under the clip. */}
              <div className="pl-6">
                <Button variant="ghost" size="sm" icon="plus" onClick={addPhase}>
                  Add phase
                </Button>
              </div>
            </div>
          </div>
        </div>

        {phase && (
          <div
            // Keyed per phase so moving the focus is visible as a change — the
            // incoming panel plays the same entrance as the board's focus panel;
            // reduced motion resolves instantly via the global kill switch.
            key={phase.id}
            className="space-y-5 border-t border-line px-2.5 py-3 motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both] sm:p-5"
          >
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
              <h3 className="text-heading font-semibold text-ink">
                Phase {pi + 1}
                <span className="font-normal text-ink-faint"> of {form.phases.length}</span>
              </h3>
              {problems[pi] && <span className={chipClass()}>{problems[pi]}</span>}
              {/* Features authored via the API ride along untouched; saying so
                  beats a silent field the form appears not to know about. */}
              {phase.retry && (
                <span
                  className={chipClass()}
                  title={`Retries failed steps: ${phase.retry.attempts} attempts, ${phase.retry.backoffSeconds}s backoff (set via the API; preserved on save)`}
                >
                  retry ×{phase.retry.attempts}
                </span>
              )}
              {phase.produces && (
                <span
                  className={`${chipClass()} font-mono`}
                  title={`Publishes its payload as {{artifacts.${phase.produces}}} (set via the API; preserved on save)`}
                >
                  <Icon name="arrow-right" size={11} />
                  {phase.produces}
                </span>
              )}
              <div className="ml-auto flex items-center gap-0.5">
                <IconButton
                  icon="arrow-up"
                  label="Move phase up"
                  size="sm"
                  disabled={pi === 0}
                  onClick={() => setForm((f) => ({ ...f, phases: move(f.phases, pi, pi - 1) }))}
                />
                <IconButton
                  icon="arrow-down"
                  label="Move phase down"
                  size="sm"
                  disabled={pi === form.phases.length - 1}
                  onClick={() => setForm((f) => ({ ...f, phases: move(f.phases, pi, pi + 1) }))}
                />
                <IconButton
                  icon="trash"
                  label="Remove phase"
                  size="sm"
                  variant="quiet-danger"
                  onClick={() => removePhase(pi)}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
              <Field label="Name">
                <input
                  className={FIELD}
                  aria-label={`Phase ${pi + 1} name`}
                  placeholder="Phase name"
                  value={phase.name}
                  onChange={(e) => setPhase(pi, { name: e.target.value })}
                />
              </Field>
              <Field label="Working directory">
                <input
                  className={`${FIELD} font-mono`}
                  aria-label={`Phase ${pi + 1} working directory`}
                  placeholder="Working directory (absolute path)"
                  value={phase.cwd}
                  onChange={(e) => setPhase(pi, { cwd: e.target.value })}
                />
              </Field>
            </div>

            {/* The product's defining idea gets a control that looks like one:
                a gate is where a human decides, and it lights in the colour the
                board uses for "waiting on you". */}
            <label
              // A tone block like the steps below it; only a gate that is on
              // gets an edge, in the colour that means "waiting on you".
              className={`flex cursor-pointer items-start gap-3 rounded-tile border px-3 py-3 transition-[border-color,background-color] duration-(--duration-quick) sm:px-4 sm:py-3.5 ${
                phase.gated
                  ? "border-await/45 bg-await/[0.08]"
                  : "border-transparent bg-surface hover:bg-surface-2"
              }`}
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-await"
                checked={phase.gated}
                onChange={(e) => setPhase(pi, { gated: e.target.checked })}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-start gap-2 text-heading font-semibold text-ink">
                  <Icon
                    name="approve"
                    size={17}
                    className={`mt-px ${phase.gated ? "text-await" : "text-ink-faint"}`}
                  />
                  <span className="min-w-0">Requires human approval (gated)</span>
                </span>
                <span className="mt-1 block text-small text-ink-dim">
                  The pipeline stops after this phase until someone approves what it produced, or
                  sends it back with a note.
                </span>
                {(phase.rubric || phase.autoApprove) && (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {phase.rubric && (
                      <span
                        className={chipClass()}
                        title="Carries a quality rubric (set via the API; preserved on save)"
                      >
                        rubric
                      </span>
                    )}
                    {phase.autoApprove && (
                      <span
                        className={chipClass()}
                        title="The gate opens itself when the verdict clears the bar (set via the API; preserved on save)"
                      >
                        auto-approve
                      </span>
                    )}
                  </span>
                )}
              </span>
            </label>

            <PanelPart
              title="Steps"
              hint="Each step is one headless agent run with its own prompt; a phase's steps run in order."
            >
              <ol className="space-y-3">
                {phase.steps.map((step, si) => {
                  const runtime = effective(phase, step);
                  const efforts = effortsFor(runtime);
                  return (
                    <li key={si} className="min-w-0 rounded-tile bg-surface p-2.5 sm:p-4">
                      <div className="flex items-center gap-2">
                        <span className="eyebrow">Step {si + 1}</span>
                        <div className="ml-auto flex items-center gap-0.5">
                          <IconButton
                            icon="arrow-up"
                            label="Move step up"
                            size="sm"
                            disabled={si === 0}
                            onClick={() => setPhase(pi, { steps: move(phase.steps, si, si - 1) })}
                          />
                          <IconButton
                            icon="arrow-down"
                            label="Move step down"
                            size="sm"
                            disabled={si === phase.steps.length - 1}
                            onClick={() => setPhase(pi, { steps: move(phase.steps, si, si + 1) })}
                          />
                          <IconButton
                            icon="trash"
                            label="Remove step"
                            size="sm"
                            variant="quiet-danger"
                            onClick={() =>
                              setPhase(pi, { steps: phase.steps.filter((_, k) => k !== si) })
                            }
                          />
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-3">
                        <Field label="Name" className="min-w-[12rem] flex-[2]">
                          <input
                            className={FIELD}
                            aria-label={`Phase ${pi + 1} step ${si + 1} name`}
                            placeholder="Step name"
                            value={step.name}
                            onChange={(e) => setStep(pi, si, { name: e.target.value })}
                          />
                        </Field>
                        <div className="min-w-[10rem] flex-1">
                          <RuntimeSelect
                            caption="Runtime"
                            fieldClass={PICKER}
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
                        </div>
                        {efforts.length > 0 && (
                          <div className="min-w-[9rem] flex-1">
                            <ReasoningEffortSelect
                              key={`step-effort:${pi}:${si}:${runtime}`}
                              caption="Effort"
                              fieldClass={PICKER}
                              label="Use pipeline effort"
                              ariaLabel={`Use pipeline effort (phase ${pi + 1} step ${si + 1})`}
                              value={step.reasoningEffort}
                              efforts={efforts}
                              onChange={(reasoningEffort) => setStep(pi, si, { reasoningEffort })}
                            />
                          </div>
                        )}
                        <div className="min-w-[10rem] flex-1">
                          <ModelSelect
                            key={`step:${pi}:${si}:${runtime}`}
                            caption="Model"
                            fieldClass={PICKER}
                            label="Use pipeline default"
                            ariaLabel={`Use pipeline default (phase ${pi + 1} step ${si + 1})`}
                            value={step.model}
                            {...(aliasesFor(runtime) ? { aliases: aliasesFor(runtime) } : {})}
                            onChange={(m) => setStep(pi, si, { model: m })}
                          />
                        </div>
                      </div>
                      <Field label="Prompt" className="mt-3">
                        <textarea
                          className={PROMPT_FIELD}
                          aria-label={`Phase ${pi + 1} step ${si + 1} prompt`}
                          placeholder="Step prompt"
                          value={step.prompt}
                          onChange={(e) => setStep(pi, si, { prompt: e.target.value })}
                        />
                      </Field>
                    </li>
                  );
                })}
              </ol>
              <Button
                size="sm"
                icon="plus"
                className="mt-3"
                onClick={() => setPhase(pi, { steps: [...phase.steps, newStep()] })}
              >
                Add step
              </Button>
            </PanelPart>

            {form.phases.length > 1 && (
              <PanelPart
                title="Starts after"
                hint="The phases this one waits for. Phases that already run after it are greyed out — depending on one would be a cycle."
              >
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
                        className={`${TOGGLE} border-line`}
                        onClick={() => toggleNeed(phase.id, other.id)}
                      >
                        <Icon
                          name={on ? "check" : "plus"}
                          size={13}
                          className={on ? "text-eye" : "text-ink-faint"}
                        />
                        {nameOf.get(other.id)}
                      </button>
                    );
                  })}
                  {(effIds.get(phase.id) ?? []).length === 0 && (
                    <span className="text-caption text-ink-faint">
                      Nothing — this phase starts immediately.
                    </span>
                  )}
                </div>
                {/* Each edge's condition, right under the toggles that create it:
                    a route is a property of the dependency, not of the phase. */}
                <EdgeConditions
                  phases={form.phases}
                  phase={phase}
                  fieldClass={`${fieldClass} h-8`}
                  onPhases={(phases) => setForm((f) => ({ ...f, phases }))}
                />
              </PanelPart>
            )}

            <PanelPart
              title="Result"
              hint="A small structured answer other phases can route on, written by the agent rather than read from its prose."
            >
              <ResultEditor
                phase={phase}
                index={pi}
                fieldClass={`${fieldClass} h-8`}
                onChange={(patch) => setPhase(pi, patch)}
              />
            </PanelPart>

            <PanelPart
              title="Runtime and limits"
              hint="Overrides for this phase. A step that runs too long, or goes quiet, is stopped."
            >
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-4">
                <RuntimeSelect
                  caption="Runtime"
                  fieldClass={PICKER}
                  label="Use pipeline runtime"
                  ariaLabel={`Runtime (phase ${pi + 1})`}
                  value={phase.runtime}
                  runtimes={runtimes}
                  onChange={(r) => setPhase(pi, { runtime: r })}
                />
                <Field label="Isolation" plain>
                  <IsolationSelect
                    fieldClass={FIELD}
                    ariaLabel={`Isolation (phase ${pi + 1})`}
                    inheritLabel="Use pipeline isolation"
                    value={phase.workspace}
                    onChange={(scope) =>
                      setForm((f) => ({
                        ...f,
                        phases: f.phases.map((p, j) => (j === pi ? withWorkspace(p, scope) : p)),
                      }))
                    }
                  />
                </Field>
                <Field label="Timeout (s)" hint="Blank: no limit">
                  <input
                    type="number"
                    min={1}
                    max={86400}
                    className={FIELD}
                    aria-label={`Timeout in seconds (phase ${pi + 1})`}
                    title="Kill a step's process if it runs longer than this. Blank = no limit."
                    value={phase.timeoutSeconds ?? ""}
                    onChange={(e) =>
                      setPhase(pi, {
                        timeoutSeconds: e.target.value === "" ? undefined : Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Stall limit (s)" hint="Blank: off · at least 30">
                  <input
                    type="number"
                    min={30}
                    max={86400}
                    className={FIELD}
                    aria-label={`Stall limit in seconds (phase ${pi + 1})`}
                    title="Kill a step if its transcript goes this many seconds without new activity, even though it is still alive. Blank = off. Minimum 30."
                    value={phase.stallSeconds ?? ""}
                    onChange={(e) =>
                      setPhase(pi, {
                        stallSeconds: e.target.value === "" ? undefined : Number(e.target.value),
                      })
                    }
                  />
                </Field>
              </div>
            </PanelPart>

            <PanelPart
              title="Candidates"
              hint="Run the step several times at once and let the phase's checks pick the winner."
            >
              <CandidateFields
                phase={phase}
                index={pi}
                pipelineWorkspace={form.workspace}
                runtimes={runtimes}
                aliasesFor={aliasesFor}
                effective={effective}
                onChange={(patch) => setPhase(pi, patch)}
              />
            </PanelPart>
          </div>
        )}
      </FormSection>
    </div>
  );
}
