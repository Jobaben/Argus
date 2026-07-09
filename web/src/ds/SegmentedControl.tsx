export interface Segment<T extends string> {
  value: T;
  label: string;
}

/**
 * A compact segmented control for mutually exclusive view options (e.g. the
 * Chronicle window picker). Radio-group semantics: one always selected.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-ground-2 p-0.5"
    >
      {segments.map((s) => {
        const selected = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(s.value)}
            className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition ${
              selected ? "bg-surface-2 text-ink" : "text-ink-faint hover:text-ink-dim"
            }`}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
