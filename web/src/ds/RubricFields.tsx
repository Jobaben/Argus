import type { Rubric, RubricCriterion } from "../types";
import { slugify } from "./slug";

/**
 * The rubric editor.
 *
 * Collapsed by default and off by default, because scoring is opt-in: most
 * schedules do not want it, and a form that opens with an empty scoring section
 * teaches people to scroll past a whole feature.
 *
 * Criterion **ids** are the load-bearing part and the editor says so — scores
 * are keyed by id, so renaming a label keeps the trend line intact while
 * changing an id starts a new one. Ids are slugified as you type rather than
 * validated after the fact, so the field cannot hold something the server will
 * reject.
 */

const EMPTY: Rubric = { goal: "", criteria: [{ id: "", label: "" }] };

export function RubricFields({
  value,
  onChange,
  fieldClass,
  /** Gated phases can auto-approve on a score; schedules cannot. */
  autoApprove,
  onAutoApproveChange,
}: {
  value: Rubric | null | undefined;
  onChange: (rubric: Rubric | null) => void;
  fieldClass: string;
  autoApprove?: number | null;
  onAutoApproveChange?: (verdict: number | null) => void;
}) {
  const enabled = value != null;
  const rubric = value ?? EMPTY;

  const setCriterion = (i: number, patch: Partial<RubricCriterion>) => {
    const criteria = rubric.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c));
    onChange({ ...rubric, criteria });
  };

  return (
    <fieldset className="rounded-lg border border-line p-3">
      <legend className="px-1">
        <label className="flex items-center gap-2 text-xs font-medium text-ink-dim">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange(e.target.checked ? EMPTY : null)}
          />
          <span>Score the output against a rubric</span>
        </label>
      </legend>

      {!enabled ? (
        <p className="text-xs text-ink-faint">
          Exit code 0 means the process ended, not that the work was good. Turn this on to have each
          run's output scored 0–10 against criteria you write — scores trend over time, and a score
          under your threshold opens an issue.
        </p>
      ) : (
        <div className="space-y-3">
          <label className="block space-y-1 text-xs font-medium text-ink-dim">
            <span>What does good look like here?</span>
            <textarea
              className={`${fieldClass} h-16`}
              placeholder="A triage summary that names every new failure and proposes one next step each."
              value={rubric.goal}
              onChange={(e) => onChange({ ...rubric, goal: e.target.value })}
            />
          </label>

          <div className="space-y-2">
            <span className="block text-xs font-medium text-ink-dim">Criteria</span>
            {rubric.criteria.map((c, i) => (
              <div key={i} className="flex flex-wrap items-start gap-2">
                <input
                  className={`${fieldClass} w-28 font-mono text-xs`}
                  placeholder="id"
                  aria-label={`Criterion ${i + 1} id`}
                  value={c.id}
                  onChange={(e) => setCriterion(i, { id: slugify(e.target.value) })}
                />
                <input
                  className={`${fieldClass} min-w-40 flex-1`}
                  placeholder="Names every new failure"
                  aria-label={`Criterion ${i + 1} label`}
                  value={c.label}
                  onChange={(e) => setCriterion(i, { label: e.target.value })}
                />
                <input
                  className={`${fieldClass} w-20`}
                  type="number"
                  min={0.1}
                  step={0.1}
                  placeholder="weight"
                  aria-label={`Criterion ${i + 1} weight`}
                  value={c.weight ?? ""}
                  onChange={(e) =>
                    setCriterion(i, {
                      weight: e.target.value === "" ? undefined : Number(e.target.value),
                    })
                  }
                />
                {rubric.criteria.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove criterion ${i + 1}`}
                    onClick={() =>
                      onChange({ ...rubric, criteria: rubric.criteria.filter((_, j) => j !== i) })
                    }
                    className="rounded-md border border-line px-2 py-2 text-xs text-ink-faint hover:text-fail"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                onChange({ ...rubric, criteria: [...rubric.criteria, { id: "", label: "" }] })
              }
              className="rounded-md border border-line px-2 py-1 text-xs text-ink-dim hover:text-ink"
            >
              + Criterion
            </button>
            <p className="text-[11px] text-ink-faint">
              The id keys the score history: rename a label freely, change an id and the trend
              starts over.
            </p>
          </div>

          <label className="block space-y-1 text-xs font-medium text-ink-dim">
            <span>Regression threshold (optional)</span>
            <input
              className={`${fieldClass} w-28`}
              type="number"
              min={0}
              max={10}
              step={0.5}
              placeholder="none"
              // The wrapping label carries the whole explanation; without an
              // explicit name a screen reader would announce all of it as the
              // field's label every time focus lands here.
              aria-label="Regression threshold, 0 to 10"
              value={rubric.minScore ?? ""}
              onChange={(e) =>
                onChange({
                  ...rubric,
                  minScore: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
            />
            <span className="block text-[11px] font-normal text-ink-faint">
              A run scoring below this opens an issue, even though the process exited fine. Leave
              empty to measure without ever failing anything.
            </span>
          </label>

          {onAutoApproveChange && (
            <label className="block space-y-1 text-xs font-medium text-ink-dim">
              <span>Auto-approve this gate at (optional)</span>
              <input
                className={`${fieldClass} w-28`}
                type="number"
                min={0}
                max={10}
                step={0.5}
                placeholder="never"
                aria-label="Auto-approve this gate at, 0 to 10"
                value={autoApprove ?? ""}
                onChange={(e) =>
                  onAutoApproveChange(e.target.value === "" ? null : Number(e.target.value))
                }
              />
              <span className="block text-[11px] font-normal text-ink-faint">
                Every step of the phase must score at least this to pass unattended. No score yet,
                or any step below the bar, and the gate keeps waiting for you.
              </span>
            </label>
          )}
        </div>
      )}
    </fieldset>
  );
}
