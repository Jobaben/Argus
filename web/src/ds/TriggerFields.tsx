import type { Trigger } from "../types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function TriggerFields({
  value,
  onChange,
  allowManual = false,
  allowWindowed = false,
  fieldClass,
}: {
  value: Trigger | null;
  onChange: (t: Trigger | null) => void;
  allowManual?: boolean;
  allowWindowed?: boolean;
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
          else if (k === "windowed") onChange({ kind: "windowed", startTime: "09:00", endTime: "17:00", everyMinutes: 30 });
          else onChange({ kind: "weekly", time: "02:00", weekday: 1 });
        }}
      >
        {allowManual && <option value="manual">Manual (run-now only)</option>}
        <option value="interval">Every N minutes</option>
        <option value="daily">Daily at time</option>
        <option value="weekly">Weekly on day</option>
        {allowWindowed && <option value="windowed">During a daily window</option>}
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
      {value?.kind === "windowed" && (
        <>
          <input
            type="time"
            aria-label="Window start"
            className={`${fieldClass} w-32`}
            value={value.startTime ?? "09:00"}
            onChange={(e) => onChange({ ...value, startTime: e.target.value })}
          />
          <span className="text-xs opacity-60">to</span>
          <input
            type="time"
            aria-label="Window end"
            className={`${fieldClass} w-32`}
            value={value.endTime ?? "17:00"}
            onChange={(e) => onChange({ ...value, endTime: e.target.value })}
          />
          <input
            type="number"
            min={1}
            aria-label="Cadence minutes"
            className={`${fieldClass} w-24`}
            value={value.everyMinutes ?? 30}
            onChange={(e) => onChange({ ...value, everyMinutes: Number(e.target.value) })}
          />
          <span className="text-xs opacity-60">min</span>
          <div className="flex gap-1">
            {DAYS.map((d, i) => {
              const on = (value.weekdays ?? []).includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  aria-label={d}
                  aria-pressed={on}
                  className={`${fieldClass} w-auto px-2 ${on ? "font-bold" : "opacity-50"}`}
                  onClick={() => {
                    const cur = value.weekdays ?? [];
                    const next = on
                      ? cur.filter((x) => x !== i)
                      : [...cur, i].sort((a, b) => a - b);
                    onChange({ ...value, weekdays: next });
                  }}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
