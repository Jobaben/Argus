import { useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useLaunch } from "../useLaunch";
import { runtimeCommand, useRuntimes } from "../useRuntimes";
import type { AgentRuntimeId, LaunchInput, Run } from "../types";
import {
  AlertStrip,
  Button,
  EmptyState,
  fieldClass,
  formatUsd,
  Handoff,
  Icon,
  labelClass,
  prefersReducedMotion,
  SkeletonRows,
} from "../ds";
import { LiveDot, RunRow } from "./RunRow";
import { ModelSelect } from "../ds/ModelSelect";
import { ReasoningEffortSelect } from "../ds/ReasoningEffortSelect";
import { RuntimeSelect } from "../ds/RuntimeSelect";
import { loadError } from "../live/loadError";

const EMPTY: LaunchInput = { name: "", prompt: "", cwd: "" };

/**
 * The one height for a form's single-line controls — inputs and selects alike —
 * so a row like "Weekly on [Mon] at [02:00]" lines up: bare `fieldClass` let a
 * select, a text input and a time input each take the browser's own height.
 * Shared with the schedule form, and the same height the pipeline form uses.
 */
export const controlClass = `${fieldClass} h-9`;

/**
 * A labelled form field: the label above the control, a short hint beside it,
 * help text under it — and, once a required field has been left empty, the
 * word "Required" on the label line, where the eye already is. The reason a
 * submit was disabled used to live only in the button's tooltip.
 *
 * The control is a render prop so it can take the label's `id` and be
 * *described* by the hint, the help and "Required" rather than named by them:
 * wrapped in one `<label>`, all of it became the field's accessible name, and
 * the name field was announced as "Name optional Defaults to the prompt's
 * first line."
 *
 * Shared with the schedule form, which is the other half of the same machinery.
 */
export function Field({
  label,
  hint,
  help,
  invalid = false,
  className = "",
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  help?: ReactNode;
  invalid?: boolean;
  className?: string;
  children: (control: { id: string; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy =
    [hint != null && `${id}-hint`, invalid && `${id}-required`, help != null && `${id}-help`]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <label htmlFor={id} className={labelClass}>
          {label}
        </label>
        {hint != null && (
          <span id={`${id}-hint`} className="text-caption text-ink-faint">
            {hint}
          </span>
        )}
        {invalid && (
          <span
            id={`${id}-required`}
            className="ml-auto inline-flex items-center gap-1 text-caption font-semibold text-fail"
          >
            <Icon name="alert" size={12} />
            Required
          </span>
        )}
      </div>
      {children({ id, "aria-describedby": describedBy })}
      {help != null && (
        <span id={`${id}-help`} className="text-caption text-ink-faint">
          {help}
        </span>
      )}
    </div>
  );
}

/** "a, b and c" — the missing fields, in the order the form asks for them. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A form's closing row: what is still missing, said in words beside the
 * disabled button it explains (and wired to it as its description); a save
 * error just above, next to the button that caused it; the buttons last, the
 * primary at the far right.
 */
export function FormFooter({
  hintId,
  missing,
  verb,
  error,
  errorSubject,
  children,
}: {
  hintId: string;
  missing: string[];
  verb: string;
  error: string | null;
  errorSubject: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-6 space-y-3 border-t border-line pt-4">
      {error && <AlertStrip subject={errorSubject} message={error} />}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        {missing.length > 0 && (
          <p
            id={hintId}
            className="mr-auto flex min-w-0 items-center gap-1.5 text-caption text-ink-faint"
          >
            <Icon name="info" size={13} />
            <span>
              Add {joinList(missing)} to {verb}.
            </span>
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * Who runs it: the runtime, then the model and effort it offers. A labelled
 * group of its own so "which agent" never blurs into "which prompt", and in the
 * same order on both forms. The grid closes up when a runtime has no effort
 * levels to offer.
 */
export function AgentFields({ children }: { children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="min-w-0">
      <p id={id} className="eyebrow mb-3">
        Agent
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">{children}</div>
    </div>
  );
}

function LaunchForm({
  form,
  setForm,
  onLaunch,
  recentCwds,
  promptRef,
}: {
  form: LaunchInput;
  setForm: (f: LaunchInput) => void;
  onLaunch: (input: LaunchInput) => Promise<void>;
  /** Directories past runs used, offered as suggestions for the next one. */
  recentCwds: string[];
  /** The prompt box, so Reuse can move focus to the form it just filled. */
  promptRef: Ref<HTMLTextAreaElement>;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which required fields the user has been in and left — "Required" appears
  // only after that, not on a form nobody has touched yet.
  const [left, setLeft] = useState<{ prompt?: boolean; cwd?: boolean }>({});
  const hintId = useId();
  const cwdListId = useId();
  const { runtimes, default: defaultRuntime } = useRuntimes();
  const active: AgentRuntimeId = form.runtime ?? defaultRuntime;
  const runtimeInfo = runtimes.find((r) => r.id === active);
  const aliases = runtimeInfo?.models;
  const command = runtimeCommand(active);
  const missing = [
    !form.prompt.trim() && "a prompt",
    !form.cwd.trim() && "a working directory",
  ].filter((m): m is string => Boolean(m));
  const valid = missing.length === 0;
  const promptInvalid = !!left.prompt && !form.prompt.trim();
  const cwdInvalid = !!left.cwd && !form.cwd.trim();

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onLaunch(form);
      setLeft({});
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="@container rounded-panel border border-line bg-surface p-5 shadow-raised sm:p-6">
      <div className="mb-5">
        <h2 className="text-title font-semibold text-ink">New one-off run</h2>
        <p className="mt-0.5 text-small text-ink-dim">
          Runs once, right now, and lands in the list with a live log.
        </p>
      </div>
      <div className="space-y-5">
        <Field
          label={
            <>
              Prompt for <code className="font-mono font-normal text-ink">{command}</code>
            </>
          }
          invalid={promptInvalid}
        >
          {(control) => (
            <textarea
              {...control}
              ref={promptRef}
              className={`${fieldClass} min-h-32 w-full resize-y leading-relaxed`}
              placeholder="Summarize the open TODOs in this repo and rank them by risk"
              aria-invalid={promptInvalid || undefined}
              value={form.prompt}
              onBlur={() => setLeft((l) => ({ ...l, prompt: true }))}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            />
          )}
        </Field>
        <div className="grid gap-5 @md:grid-cols-2">
          <Field label="Working directory" hint="absolute path" invalid={cwdInvalid}>
            {(control) => (
              <input
                {...control}
                className={`${controlClass} w-full font-mono`}
                placeholder="/home/you/project"
                list={recentCwds.length > 0 ? cwdListId : undefined}
                aria-invalid={cwdInvalid || undefined}
                value={form.cwd}
                onBlur={() => setLeft((l) => ({ ...l, cwd: true }))}
                onChange={(e) => setForm({ ...form, cwd: e.target.value })}
              />
            )}
          </Field>
          <Field label="Name" hint="optional" help="Defaults to the prompt's first line.">
            {(control) => (
              <input
                {...control}
                className={`${controlClass} w-full`}
                placeholder="Quick repo audit"
                value={form.name ?? ""}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
        </div>
        {recentCwds.length > 0 && (
          <datalist id={cwdListId}>
            {recentCwds.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        )}
        <AgentFields>
          <RuntimeSelect
            fieldClass={controlClass}
            caption="Runtime"
            label="Runtime (server default)"
            value={form.runtime}
            runtimes={runtimes}
            // Switching CLI invalidates the model: "haiku" means nothing to Codex
            // and a stale alias would fail at spawn rather than in the form.
            onChange={(r) =>
              setForm({ ...form, runtime: r, model: undefined, reasoningEffort: undefined })
            }
          />
          <ModelSelect
            key={active}
            fieldClass={controlClass}
            caption="Model"
            label="Model (inherit CLI)"
            value={form.model}
            {...(aliases ? { aliases } : {})}
            onChange={(m) => setForm({ ...form, model: m })}
          />
          <ReasoningEffortSelect
            key={`launch-effort:${active}`}
            fieldClass={controlClass}
            caption="Effort"
            label="Effort (inherit CLI)"
            value={form.reasoningEffort}
            efforts={runtimeInfo?.reasoningEfforts ?? []}
            onChange={(reasoningEffort) => setForm({ ...form, reasoningEffort })}
          />
        </AgentFields>
      </div>
      <FormFooter
        hintId={hintId}
        missing={missing}
        verb="launch"
        error={err}
        errorSubject="Couldn't launch the run"
      >
        <Button
          variant="primary"
          icon="play"
          disabled={busy || !valid}
          aria-describedby={valid ? undefined : hintId}
          onClick={submit}
        >
          {busy ? "Launching…" : "Launch"}
        </Button>
      </FormFooter>
    </div>
  );
}

/**
 * The Scheduler's One-off sub-tab: fire a single headless run right now.
 *
 * A one-off run is a schedule with no trigger — same form fields, same run
 * rows, same machinery on the server — which is why it lives inside the
 * Scheduler rather than as a destination of its own. No `Page` here: the
 * Scheduler supplies the heading, the sub-tab switch and the explanation.
 *
 * On a wide screen the form and the history sit side by side, the form held in
 * view while the list scrolls: launching and watching the run land are one
 * motion, and the form used to stretch across the whole page above an empty
 * list.
 */
export function LaunchPanel() {
  const { runs, loading, error, launch, cancelRun } = useLaunch();
  const [form, setForm] = useState<LaunchInput>(EMPTY);
  const formRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const live = runs.filter((r) => r.status === "running").length;
  // Null rather than $0.00 when nothing reported a cost: an unpriced list and a
  // free one are different facts.
  const spend = runs.some((r) => r.costUsd != null)
    ? runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
    : null;
  const recentCwds = useMemo(() => [...new Set(runs.map((r) => r.cwd).filter(Boolean))], [runs]);

  // Reuse fills a form that may be a long way up the page; bring it back into
  // view, unless it is already there (beside the list, on a wide screen).
  const revealForm = () => {
    const el = formRef.current;
    if (!el) return;
    const { top } = el.getBoundingClientRect();
    if (top >= 64 && top <= window.innerHeight - 160) return;
    el.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  const rerunButton = (run: Run) => (
    <Button
      variant="ghost"
      size="sm"
      icon="copy"
      onClick={() => {
        setForm({
          name: run.scheduleName,
          prompt: run.prompt,
          cwd: run.cwd,
          ...(run.model ? { model: run.model } : {}),
          ...(run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}),
          ...(run.runtime ? { runtime: run.runtime } : {}),
        });
        revealForm();
        // Focus follows the filled form, so a screen reader hears what Reuse
        // did instead of staying on a button far down the list. The scroll is
        // revealForm's; focusing must not jump ahead of it.
        promptRef.current?.focus({ preventScroll: true });
      }}
      title="Copy this run's prompt, directory, runtime and model back into the form"
    >
      Reuse
    </Button>
  );

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:gap-8">
      <div ref={formRef} className="scroll-mt-20 xl:sticky xl:top-20">
        <LaunchForm
          form={form}
          setForm={setForm}
          recentCwds={recentCwds}
          promptRef={promptRef}
          onLaunch={async (input) => {
            await launch({
              prompt: input.prompt,
              cwd: input.cwd,
              ...(input.name?.trim() ? { name: input.name.trim() } : {}),
              ...(input.model ? { model: input.model } : {}),
              ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
              ...(input.runtime ? { runtime: input.runtime } : {}),
            });
            // Keep the directory, runtime and model, clear what was one-shot.
            // People fire several prompts at the same repo in a row; making them
            // retype an absolute path each time was the single most tedious
            // thing here.
            setForm({
              ...EMPTY,
              cwd: input.cwd,
              ...(input.model ? { model: input.model } : {}),
              ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
              ...(input.runtime ? { runtime: input.runtime } : {}),
            });
          }}
        />
      </div>

      <section aria-label="Recent one-off runs" className="min-w-0">
        <div className="mb-3 flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="eyebrow">Recent one-off runs</h2>
          {live > 0 && (
            <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-run">
              <LiveDot />
              {live} in flight
            </span>
          )}
          {spend != null && (
            <span
              className="ml-auto text-caption text-ink-faint"
              title="Total reported cost of the runs listed below"
            >
              {formatUsd(spend)} across {runs.length} {runs.length === 1 ? "run" : "runs"}
            </span>
          )}
        </div>

        {error && (
          <div className="mb-4">
            <AlertStrip subject="Runs" message={loadError("recent runs", error)} />
          </div>
        )}

        <Handoff
          busy={loading && runs.length === 0}
          label="runs"
          skeleton={<SkeletonRows count={4} />}
        >
          {runs.length === 0 ? (
            // A load error already says why the list is empty; "nothing
            // launched" under it would be a second, wrong explanation.
            error ? null : (
              <EmptyState title="Nothing launched yet" icon="bolt">
                A one-off run is the same machinery a schedule uses, fired once: the log tails live,
                the cost is metered against your budget, and the transcript is kept. Use{" "}
                <strong className="font-semibold text-ink">Reuse</strong> on any past run to load
                its prompt back into the form.
              </EmptyState>
            )
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
              {runs.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  label={r.scheduleName}
                  onCancel={cancelRun}
                  extraActions={rerunButton(r)}
                />
              ))}
            </ul>
          )}
        </Handoff>
      </section>
    </div>
  );
}

export default LaunchPanel;
