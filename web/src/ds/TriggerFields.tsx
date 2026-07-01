import type { Trigger } from "../types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function TriggerFields({
  value,
  onChange,
  allowManual = false,
  fieldClass,
}: {
  value: Trigger | null;
  onChange: (t: Trigger | null) => void;
  allowManual?: boolean;
  fieldClass: string;
}) {
  const kind = value === null ? "manual" : value.kind;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={`${fieldClass} w-auto`}
        value={kind}
        onChange={(e) => {
          const k = e.target.value;
          if (k === "manual") onChange(null);
          else if (k === "interval") onChange({ kind: "interval", everyMinutes: 60 });
          else if (k === "daily") onChange({ kind: "daily", time: "02:00" });
          else onChange({ kind: "weekly", time: "02:00", weekday: 1 });
        }}
      >
        {allowManual && <option value="manual">Manual (run-now only)</option>}
        <option value="interval">Every N minutes</option>
        <option value="daily">Daily at time</option>
        <option value="weekly">Weekly on day</option>
      </select>

      {value?.kind === "interval" && (
        <input
          type="number"
          min={1}
          className={`${fieldClass} w-28`}
          value={value.everyMinutes ?? 60}
          onChange={(e) => onChange({ kind: "interval", everyMinutes: Number(e.target.value) })}
        />
      )}
      {(value?.kind === "daily" || value?.kind === "weekly") && (
        <input
          type="time"
          className={`${fieldClass} w-32`}
          value={value.time ?? "02:00"}
          onChange={(e) => onChange({ ...value, time: e.target.value })}
        />
      )}
      {value?.kind === "weekly" && (
        <select
          className={`${fieldClass} w-auto`}
          value={value.weekday ?? 1}
          onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}
        >
          {DAYS.map((d, i) => (
            <option key={d} value={i}>{d}</option>
          ))}
        </select>
      )}
    </div>
  );
}
