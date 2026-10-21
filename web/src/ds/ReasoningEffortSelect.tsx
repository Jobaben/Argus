import { useId } from "react";
import type { ReasoningEffort } from "../types";
import { labelClass } from "./controls";

/**
 * Runtime-driven reasoning picker. An empty value inherits Codex config.
 *
 * Renders nothing for a runtime with no reasoning overrides — caption and all,
 * so a form grid closes the gap instead of keeping a labelled hole.
 */
export function ReasoningEffortSelect({
  label,
  ariaLabel,
  caption,
  value,
  efforts,
  onChange,
  fieldClass,
}: {
  label: string;
  ariaLabel?: string;
  /** A visible label above the picker, for a form laid out in a grid. */
  caption?: string;
  value?: ReasoningEffort | null;
  efforts: ReasoningEffort[];
  onChange: (value: ReasoningEffort | undefined) => void;
  fieldClass: string;
}) {
  const id = useId();
  if (efforts.length === 0) return null;
  const select = (
    <select
      id={caption ? id : undefined}
      aria-label={ariaLabel ?? label}
      className={`${fieldClass} ${caption ? "w-full" : "w-auto"}`}
      value={value ?? ""}
      onChange={(event) =>
        onChange(event.target.value ? (event.target.value as ReasoningEffort) : undefined)
      }
    >
      <option value="">{label}</option>
      {efforts.map((effort) => (
        <option key={effort} value={effort}>
          {effort[0].toUpperCase() + effort.slice(1)}
        </option>
      ))}
    </select>
  );
  if (!caption) return select;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {caption}
      </label>
      {select}
    </div>
  );
}
