import type { Rubric, RubricCriterion } from "../types";
import { Button, IconButton } from "./Button";
import { labelClass } from "./controls";
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
 *
 * An inset well rather than an outlined box: it is a region of the form it sits
 * in, and its toggle is its title, so the legend lives inside the well instead
 * of notched into its border.
 */

const EMPTY: Rubric = { goal: "", criteria: [{ id: "", label: "" }] };

const HINT = "text-caption text-ink-faint";

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
    <fieldset className="min-w-0 rounded-tile border border-line bg-ground-2/50 p-4">
      <legend className="float-left w-full">
        <label className="flex w-fit cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            className="size-4 shrink-0 cursor-pointer accent-eye"
            checked={enabled}
            onChange={(e) => onChange(e.target.checked ? EMPTY : null)}
          />
          <span className="text-small font-semibold text-ink">
            Score the output against a rubric
          </span>
        </label>
      </legend>

      {!enabled ? (
        <p className={`clear-both max-w-prose pl-6.5 pt-1.5 ${HINT}`}>
          Exit code 0 means the process ended, not that the work was good. Turn this on to have each
          run's output scored 0–10 against criteria you write — scores trend over time, and a score
          under your threshold opens an issue.
        </p>
      ) : (
        <div className="clear-both space-y-5 pt-4">
          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>What does good look like here?</span>
            <textarea
              className={`${fieldClass} min-h-16 w-full resize-y leading-relaxed`}
              placeholder="A triage summary that names every new failure and proposes one next step each."
              value={rubric.goal}
              onChange={(e) => onChange({ ...rubric, goal: e.target.value })}
            />
          </label>

          <div className="space-y-2">
            <div className="flex items-baseline gap-2">
              <span className={labelClass}>Criteria</span>
              <span className={`hidden sm:inline ${HINT}`}>id · what it checks · weight</span>
            </div>
            {rubric.criteria.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  className={`${fieldClass} w-32 font-mono`}
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
                  className={`${fieldClass} w-24`}
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
                  <IconButton
                    icon="close"
                    label={`Remove criterion ${i + 1}`}
                    variant="quiet-danger"
                    onClick={() =>
                      onChange({ ...rubric, criteria: rubric.criteria.filter((_, j) => j !== i) })
                    }
                  />
                )}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                variant="ghost"
                size="sm"
                icon="plus"
                className="-ml-2"
                onClick={() =>
                  onChange({ ...rubric, criteria: [...rubric.criteria, { id: "", label: "" }] })
                }
              >
                {/* The plus is drawn; the name still says it, for the reader
                    who hears the button rather than sees it. */}
                <span className="sr-only">+</span> Criterion
              </Button>
              <p className={HINT}>
                The id keys the score history: rename a label freely, change an id and the trend
                starts over.
              </p>
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="flex items-baseline gap-2">
                <span className={labelClass}>Regression threshold</span>
                <span className={HINT}>optional</span>
              </span>
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
              <span className={HINT}>
                A run scoring below this opens an issue, even though the process exited fine. Leave
                empty to measure without ever failing anything.
              </span>
            </label>

            {onAutoApproveChange && (
              <label className="flex flex-col gap-1.5">
                <span className="flex items-baseline gap-2">
                  <span className={labelClass}>Auto-approve this gate at</span>
                  <span className={HINT}>optional</span>
                </span>
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
                <span className={HINT}>
                  Every step of the phase must score at least this to pass unattended. No score yet,
                  or any step below the bar, and the gate keeps waiting for you.
                </span>
              </label>
            )}
          </div>
        </div>
      )}
    </fieldset>
  );
}
