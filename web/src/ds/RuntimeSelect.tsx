import type { AgentRuntimeId, AgentRuntimeInfo } from "../types";

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
 */
export function RuntimeSelect({
  label,
  ariaLabel,
  value,
  onChange,
  fieldClass,
  runtimes,
}: {
  /** The text of the inherit option, e.g. "Runtime (server default)". */
  label: string;
  ariaLabel?: string;
  value?: AgentRuntimeId;
  onChange: (v: AgentRuntimeId | undefined) => void;
  fieldClass: string;
  runtimes: AgentRuntimeInfo[];
}) {
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
      : [
          { id: "claude", label: "Claude Code", available: true },
          { id: "codex", label: "Codex", available: true },
        ];
  const chosen = options.find((o) => o.id === value);

  return (
    <div className="flex items-center gap-1">
      <select
        aria-label={ariaLabel ?? label}
        className={`${fieldClass} w-auto`}
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
      {chosen && !chosen.available && (
        <span className="text-xs text-run" title={chosen.detail}>
          not on PATH
        </span>
      )}
    </div>
  );
}
