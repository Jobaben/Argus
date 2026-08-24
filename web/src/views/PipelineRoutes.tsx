import { useState } from "react";
import { conditionLabel, effectiveEdges } from "../ds";
import {
  edgeBetween,
  fieldsToSchema,
  freshFieldName,
  groupNames,
  parseValue,
  schemaFields,
  withEdge,
  withGroupFlag,
} from "./routeAuthoring";
import type { EditableField } from "./routeAuthoring";
import type { DependencyEdge, PhaseDef, RouteCondition, RoutePredicate } from "../types";

/**
 * Authoring outcome routing in the phase panel.
 *
 * Two blocks, matching the two halves of the contract. A phase declares what it
 * *decides* — an artifact name and a small flat schema — and each of its
 * dependencies declares *when* it applies. Neither is free text: the condition's
 * field list is read from the source phase's own schema, so the form can only
 * author predicates the server will accept, and a typo becomes impossible
 * rather than becoming a branch that never fires.
 *
 * Anything the form cannot draw — a nested schema, a two-segment predicate path
 * — is shown as a badge and preserved on save. The same posture the panel
 * already takes for `retry` and `rubric`: say what is there, change nothing.
 */

const TAG = "rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint";
const LABEL = "font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint";

/** Operators, in the reading order an author thinks in. */
const OPERATORS: { value: RoutePredicate["operator"]; label: string }[] = [
  { value: "equals", label: "is" },
  { value: "not-equals", label: "is not" },
  { value: "one-of", label: "is one of" },
  { value: "exists", label: "exists" },
];

/**
 * A comma-separated list of values, held as text while it is being typed.
 *
 * The list has to keep its own text: everything else in this panel is derived
 * from the definition on every render, and a definition cannot hold "pass," —
 * the half-typed state would be parsed away between one keystroke and the next,
 * so the comma could never be entered at all. Local text, parsed upward.
 */
function CommaList({
  initial,
  ariaLabel,
  className,
  placeholder,
  onChange,
}: {
  initial: string;
  ariaLabel: string;
  className: string;
  placeholder: string;
  onChange: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <input
      className={className}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}

/** True when this form can round-trip the condition without losing anything. */
function conditionEditable(
  when: RouteCondition | undefined,
  fields: EditableField[] | null,
): boolean {
  if (!when || when.default) return true;
  const predicate = when.predicate;
  if (!predicate || predicate.path.length !== 1) return false;
  return (fields ?? []).some((f) => f.name === predicate.path[0]);
}

/** The result a phase publishes: the artifact name, the step, and the fields. */
export function ResultEditor({
  phase,
  index,
  fieldClass,
  onChange,
}: {
  phase: PhaseDef;
  index: number;
  fieldClass: string;
  onChange: (patch: Partial<PhaseDef>) => void;
}) {
  const result = phase.result;
  const fields = schemaFields(result?.schema);
  const setFields = (next: EditableField[]) =>
    onChange({
      result: {
        artifact: result?.artifact ?? "",
        ...(result?.resultStep ? { resultStep: result.resultStep } : {}),
        schema: fieldsToSchema(next),
      },
    });

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-sm text-ink-dim">
        <input
          type="checkbox"
          checked={result !== undefined}
          onChange={(e) =>
            onChange({
              result: e.target.checked
                ? {
                    artifact: "",
                    // A multi-step phase must name the publishing step, or the
                    // server refuses the definition: default it to the first.
                    ...(phase.steps.length > 1 ? { resultStep: phase.steps[0]?.name ?? "" } : {}),
                    schema: { type: "object", properties: {} },
                  }
                : undefined,
            })
          }
        />
        Publishes a structured result (other phases can branch on it)
      </label>

      {result && (
        <div className="space-y-2 border-l border-line pl-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${fieldClass} w-44`}
              aria-label={`Phase ${index + 1} result artifact`}
              placeholder="Artifact name"
              value={result.artifact}
              onChange={(e) => onChange({ result: { ...result, artifact: e.target.value } })}
            />
            {phase.steps.length > 1 && (
              <select
                className={fieldClass}
                aria-label={`Phase ${index + 1} publishing step`}
                value={result.resultStep ?? ""}
                onChange={(e) => onChange({ result: { ...result, resultStep: e.target.value } })}
              >
                {phase.steps.map((s, i) => (
                  <option key={i} value={s.name}>
                    written by {s.name || `step ${i + 1}`}
                  </option>
                ))}
              </select>
            )}
          </div>

          {fields === null ? (
            <span className={TAG} title="Schema set via the API; preserved on save">
              schema set via the API
            </span>
          ) : (
            <div className="space-y-1.5">
              <span className={LABEL}>Fields</span>
              {fields.map((field, fi) => (
                <div key={fi} className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${fieldClass} w-36`}
                    aria-label={`Result field ${fi + 1} name`}
                    placeholder="Field name"
                    value={field.name}
                    onChange={(e) =>
                      setFields(
                        fields.map((f, i) => (i === fi ? { ...f, name: e.target.value } : f)),
                      )
                    }
                  />
                  <select
                    className={fieldClass}
                    aria-label={`Result field ${fi + 1} type`}
                    value={field.type}
                    onChange={(e) =>
                      setFields(
                        fields.map((f, i) =>
                          i === fi ? { ...f, type: e.target.value as EditableField["type"] } : f,
                        ),
                      )
                    }
                  >
                    <option value="string">text</option>
                    <option value="number">number</option>
                    <option value="boolean">true / false</option>
                  </select>
                  {field.type !== "boolean" && (
                    <CommaList
                      // Remounts on a rename or a reorder, not on a keystroke.
                      key={`${fi}:${field.name}`}
                      initial={field.values}
                      className={`${fieldClass} w-44`}
                      ariaLabel={`Result field ${fi + 1} allowed values`}
                      placeholder="Allowed values (comma-separated)"
                      onChange={(values) =>
                        setFields(fields.map((f, i) => (i === fi ? { ...f, values } : f)))
                      }
                    />
                  )}
                  <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
                    <input
                      type="checkbox"
                      aria-label={`Result field ${fi + 1} required`}
                      checked={field.required}
                      onChange={(e) =>
                        setFields(
                          fields.map((f, i) =>
                            i === fi ? { ...f, required: e.target.checked } : f,
                          ),
                        )
                      }
                    />
                    required
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove result field ${fi + 1}`}
                    className="rounded border border-fail/20 px-2 py-0.5 text-xs text-fail hover:bg-fail/10"
                    onClick={() => setFields(fields.filter((_, i) => i !== fi))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="rounded border border-line px-2.5 py-1 text-xs text-ink-dim hover:text-ink"
                onClick={() =>
                  setFields([
                    ...fields,
                    { name: freshFieldName(fields), type: "string", values: "", required: true },
                  ])
                }
              >
                + add field
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One dependency's condition: when it applies, and whether a skip satisfies it. */
function EdgeRow({
  phases,
  targetId,
  edge,
  sourceName,
  fieldClass,
  onPhases,
}: {
  phases: PhaseDef[];
  targetId: string;
  edge: DependencyEdge;
  sourceName: string;
  fieldClass: string;
  onPhases: (phases: PhaseDef[]) => void;
}) {
  const source = phases.find((p) => p.id === edge.phase);
  const fields = schemaFields(source?.result?.schema) ?? [];
  const decides = source?.result !== undefined && fields.length > 0;
  const editable = conditionEditable(edge.when, fields);
  const when = edge.when;
  const mode = !when ? "always" : when.default ? "otherwise" : "only-if";
  const field = fields.find((f) => f.name === when?.predicate?.path[0]) ?? fields[0];
  const setEdge = (next: DependencyEdge) => onPhases(withEdge(phases, targetId, next));
  const setWhen = (next: RouteCondition | undefined) =>
    setEdge({
      phase: edge.phase,
      ...(edge.allowSkipped ? { allowSkipped: true } : {}),
      ...(next ? { when: next } : {}),
    });

  const predicateFor = (name: string, operator: RoutePredicate["operator"]): RoutePredicate => {
    const target = fields.find((f) => f.name === name) ?? field;
    if (operator === "exists") return { path: [name], operator };
    const first = target?.values.split(",")[0]?.trim() ?? "";
    const value = parseValue(
      target?.type ?? "string",
      first || (target?.type === "number" ? "0" : ""),
    );
    return { path: [name], operator, value: operator === "one-of" ? [value] : value };
  };

  return (
    <div
      data-testid="edge-condition"
      className="flex flex-wrap items-center gap-2 rounded-md border border-line/70 bg-ground-2/40 px-2 py-1.5"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
        after {sourceName}
      </span>
      {editable ? (
        <select
          className={fieldClass}
          aria-label={`When to run after ${sourceName}`}
          value={mode}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "always") return setWhen(undefined);
            if (next === "otherwise") {
              // A default route outside a group is invalid, so name one.
              return setWhen({
                group: when?.group ?? groupNames(phases)[0] ?? "routes",
                default: true,
              });
            }
            setWhen({
              ...(when?.group ? { group: when.group } : {}),
              predicate: predicateFor(field?.name ?? "", "equals"),
            });
          }}
        >
          <option value="always">always</option>
          {decides && <option value="only-if">only if</option>}
          <option value="otherwise">otherwise (default route)</option>
        </select>
      ) : (
        <span className={TAG} title="Condition set via the API; preserved on save">
          {conditionLabel(when)}
        </span>
      )}

      {editable && mode === "only-if" && (
        <>
          <select
            className={fieldClass}
            aria-label={`Condition field for ${sourceName}`}
            value={when?.predicate?.path[0] ?? ""}
            onChange={(e) =>
              setWhen({
                ...when,
                predicate: predicateFor(e.target.value, when?.predicate?.operator ?? "equals"),
              })
            }
          >
            {fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
          <select
            className={fieldClass}
            aria-label={`Condition operator for ${sourceName}`}
            value={when?.predicate?.operator ?? "equals"}
            onChange={(e) =>
              setWhen({
                ...when,
                predicate: predicateFor(
                  when?.predicate?.path[0] ?? field?.name ?? "",
                  e.target.value as RoutePredicate["operator"],
                ),
              })
            }
          >
            {OPERATORS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {when?.predicate && when.predicate.operator !== "exists" && (
            <ValueInput
              field={field}
              fieldClass={fieldClass}
              sourceName={sourceName}
              predicate={when.predicate}
              onChange={(predicate) => setWhen({ ...when, predicate })}
            />
          )}
        </>
      )}

      {editable && mode !== "always" && (
        <>
          <input
            className={`${fieldClass} w-28`}
            aria-label={`Route group for ${sourceName}`}
            placeholder="group"
            value={when?.group ?? ""}
            onChange={(e) => {
              // Not trimmed here: trimming as you type eats the space you just
              // pressed. The server trims the name it stores.
              const group = e.target.value;
              setWhen({ ...when, ...(group ? { group } : { group: undefined }) } as RouteCondition);
            }}
          />
          {when?.group && (
            <>
              {(["exclusive", "required"] as const).map((flag) => (
                <label key={flag} className="flex items-center gap-1.5 text-[11px] text-ink-dim">
                  <input
                    type="checkbox"
                    aria-label={`Group ${when.group} ${flag}`}
                    checked={when[flag] === true}
                    onChange={(e) =>
                      onPhases(withGroupFlag(phases, when.group!, flag, e.target.checked))
                    }
                  />
                  {flag}
                </label>
              ))}
            </>
          )}
        </>
      )}

      <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-dim">
        <input
          type="checkbox"
          aria-label={`Accept a skipped ${sourceName}`}
          checked={edge.allowSkipped === true}
          onChange={(e) =>
            setEdge({
              phase: edge.phase,
              ...(edge.when ? { when: edge.when } : {}),
              ...(e.target.checked ? { allowSkipped: true } : {}),
            })
          }
        />
        accept skipped
      </label>
    </div>
  );
}

/** The value half of a predicate, typed by the field it compares. */
function ValueInput({
  field,
  fieldClass,
  sourceName,
  predicate,
  onChange,
}: {
  field: EditableField | undefined;
  fieldClass: string;
  sourceName: string;
  predicate: RoutePredicate;
  onChange: (predicate: RoutePredicate) => void;
}) {
  const label = `Condition value for ${sourceName}`;
  const allowed = (field?.values ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const current = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
  const write = (values: Array<string | number | boolean>) =>
    onChange({
      ...predicate,
      value: predicate.operator === "one-of" ? values : values[0],
    });

  if (field?.type === "boolean") {
    return (
      <select
        className={fieldClass}
        aria-label={label}
        value={String(current[0])}
        onChange={(e) => write([e.target.value === "true"])}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (allowed.length > 0 && predicate.operator !== "one-of") {
    return (
      <select
        className={fieldClass}
        aria-label={label}
        value={String(current[0] ?? "")}
        onChange={(e) => write([parseValue(field?.type ?? "string", e.target.value)])}
      >
        {allowed.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }
  return (
    <CommaList
      key={`${field?.name ?? ""}:${predicate.operator}`}
      initial={current.map((v) => String(v ?? "")).join(", ")}
      className={`${fieldClass} w-40`}
      ariaLabel={label}
      placeholder={predicate.operator === "one-of" ? "value, value" : "value"}
      onChange={(text) =>
        write(
          text
            .split(",")
            .map((v) => v.trim())
            .filter((v) => v !== "")
            .map((v) => parseValue(field?.type ?? "string", v)),
        )
      }
    />
  );
}

/** Every incoming edge of the selected phase, with its condition. */
export function EdgeConditions({
  phases,
  phase,
  fieldClass,
  onPhases,
}: {
  phases: PhaseDef[];
  phase: PhaseDef;
  fieldClass: string;
  onPhases: (phases: PhaseDef[]) => void;
}) {
  const edges = effectiveEdges(phases).get(phase.id) ?? [];
  if (edges.length === 0) return null;
  const nameOf = (id: string) => phases.find((p) => p.id === id)?.name.trim() || id;
  return (
    <div className="space-y-1.5">
      <span className={LABEL}>Routes</span>
      <div className="space-y-1.5">
        {edges.map((edge) => (
          <EdgeRow
            key={edge.phase}
            phases={phases}
            targetId={phase.id}
            // Read back through the current phases so a group-wide flag edit is
            // reflected on every row, not just the one that was clicked.
            edge={edgeBetween(phases, phase.id, edge.phase) ?? edge}
            sourceName={nameOf(edge.phase)}
            fieldClass={fieldClass}
            onPhases={onPhases}
          />
        ))}
      </div>
    </div>
  );
}
