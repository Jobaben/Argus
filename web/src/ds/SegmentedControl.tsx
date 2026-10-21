import { useRef } from "react";

export interface Segment<T extends string> {
  value: T;
  label: string;
}

/**
 * A compact segmented control for mutually exclusive view options (e.g. the
 * Chronicle window picker). Radio-group semantics: one always selected, one Tab
 * stop for the whole group, and the arrow keys move the choice — the keyboard
 * contract a radio group promises, which seven separate Tab stops did not keep.
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
  const groupRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const at = segments.findIndex((s) => s.value === value);
    const next = segments[(at + step + segments.length) % segments.length];
    onChange(next.value);
    // Focus follows the selection, as in a native radio group.
    requestAnimationFrame(() =>
      groupRef.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus(),
    );
  };
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-flex items-center gap-0.5 rounded-control border border-line bg-ground-2 p-0.5"
    >
      {segments.map((s) => {
        const selected = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-value={s.value}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(s.value)}
            className={`h-7 rounded-md px-2.5 text-caption font-semibold transition duration-(--duration-quick) motion-safe:active:scale-[0.96] ${
              selected
                ? "bg-surface-3 text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]"
                : "text-ink-faint hover:text-ink"
            }`}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
