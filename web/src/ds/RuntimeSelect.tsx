import { useId } from "react";
import { RUNTIME_IDS, RUNTIME_META } from "../useRuntimes";
import type { AgentRuntimeId, AgentRuntimeInfo } from "../types";
import { labelClass } from "./controls";
import { Icon } from "./Icon";

/**
 * Which agent CLI runs this thing — the runtime twin of {@link ModelSelect}.
 *
 * `""` means inherit (the server default for a schedule or launch, the pipeline
 * for a phase, the phase for a step) and reports `undefined`, so an unset
 * picker writes no key at all rather than freezing today's default into the
 * record.
 *
 * A runtime the server couldn't find on PATH is still offered, annotated rather
 * than hidden: someone configuring a machine they are about to install the CLI
 * on should be able to say so, and a silently missing option reads as a bug.
 *
 * `caption` works as it does on {@link ModelSelect}: a visible label above, and
 * the picker filling its column.
 */
export function RuntimeSelect({
  label,
  ariaLabel,
  caption,
  value,
  onChange,
  fieldClass,
  runtimes,
}: {
  /** The text of the inherit option, e.g. "Runtime (server default)". */
  label: string;
  ariaLabel?: string;
  /** A visible label above the picker, for a form laid out in a grid. */
  caption?: string;
  value?: AgentRuntimeId;
  onChange: (v: AgentRuntimeId | undefined) => void;
  fieldClass: string;
  runtimes: AgentRuntimeInfo[];
}) {
  const id = useId();
  // Before the roster arrives — or if the request failed — offer the ids the
  // client knows about, so the picker is never an empty dropdown.
  const options: { id: AgentRuntimeId; label: string; available: boolean; detail?: string }[] =
    runtimes.length > 0
      ? runtimes.map((r) => ({
          id: r.id,
          label: r.label,
          available: r.available,
          ...(r.detail ? { detail: r.detail } : {}),
        }))
      : RUNTIME_IDS.map((id) => ({ id, label: RUNTIME_META[id].label, available: true }));
  const chosen = options.find((o) => o.id === value);

  const select = (
    <select
      id={caption ? id : undefined}
      aria-label={ariaLabel ?? label}
      className={`${fieldClass} ${caption ? "w-full" : "w-auto"}`}
      value={value ?? ""}
      onChange={(e) =>
        onChange(e.target.value === "" ? undefined : (e.target.value as AgentRuntimeId))
      }
    >
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
          {o.available ? "" : " (not installed)"}
        </option>
      ))}
    </select>
  );
  // A spawn against a missing binary fails, so the warning says so in the
  // failure colour rather than the working one.
  const missing = chosen && !chosen.available && (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-caption font-semibold text-fail-ink"
      title={chosen.detail}
    >
      <Icon name="alert" size={13} className="text-fail" />
      not on PATH
    </span>
  );

  if (!caption) {
    return (
      <div className="flex items-center gap-1.5">
        {select}
        {missing}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {caption}
      </label>
      {select}
      {missing}
    </div>
  );
}
