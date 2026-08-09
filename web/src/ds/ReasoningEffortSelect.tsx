import type { ReasoningEffort } from "../types";

/** Runtime-driven reasoning picker. An empty value inherits Codex config. */
export function ReasoningEffortSelect({
  label,
  ariaLabel,
  value,
  efforts,
  onChange,
  fieldClass,
}: {
  label: string;
  ariaLabel?: string;
  value?: ReasoningEffort | null;
  efforts: ReasoningEffort[];
  onChange: (value: ReasoningEffort | undefined) => void;
  fieldClass: string;
}) {
  if (efforts.length === 0) return null;
  return (
    <select
      aria-label={ariaLabel ?? label}
      className={`${fieldClass} w-auto`}
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
}
