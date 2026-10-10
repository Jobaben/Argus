import { useState } from "react";
import type { Trigger } from "../types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The saved webhook credential for the item being edited — absent (rather
 *  than present-with-nulls) for a brand-new, not-yet-saved item, which has no
 *  hook URL until the first save mints its token. */
export interface HookCredential {
  url: string;
  token: string;
  onRotate: () => Promise<void> | void;
  rotating?: boolean;
}

export function TriggerFields({
  value,
  onChange,
  allowManual = false,
  allowWindowed = false,
  fieldClass,
  /** Selectable sources for an "after pipeline" trigger. Only pipelines may
   *  be a chain's source, whether the item being edited is itself a pipeline
   *  or a schedule. */
  pipelines = [],
  /** Set once this item has been saved with a webhook trigger — shows the
   *  hook URL, its token, and a Rotate action. Absent shows a "save first"
   *  hint instead. */
  hook,
}: {
  value: Trigger | null;
  onChange: (t: Trigger | null) => void;
  allowManual?: boolean;
  allowWindowed?: boolean;
  fieldClass: string;
  pipelines?: { id: string; name: string }[];
  hook?: HookCredential;
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
          else if (k === "windowed")
            onChange({ kind: "windowed", startTime: "09:00", endTime: "17:00", everyMinutes: 30 });
          else if (k === "weekly") onChange({ kind: "weekly", time: "02:00", weekday: 1 });
          else if (k === "webhook") onChange({ kind: "webhook" });
          else onChange({ kind: "after", pipelineId: pipelines[0]?.id ?? "", on: "any" });
        }}
      >
        {allowManual && <option value="manual">Manual (run-now only)</option>}
        <option value="interval">Every N minutes</option>
        <option value="daily">Daily at time</option>
        <option value="weekly">Weekly on day</option>
        {allowWindowed && <option value="windowed">During a daily window</option>}
        <option value="webhook">Webhook</option>
        <option value="after">After pipeline</option>
      </select>

      {value?.kind === "interval" && (
        <input
          type="number"
          min={1}
          aria-label="Interval in minutes"
          className={`${fieldClass} w-28`}
          value={value.everyMinutes ?? 60}
          onChange={(e) => onChange({ kind: "interval", everyMinutes: Number(e.target.value) })}
        />
      )}
      {(value?.kind === "daily" || value?.kind === "weekly") && (
        <input
          type="time"
          aria-label="Time of day"
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
            <option key={d} value={i}>
              {d}
            </option>
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

      {value?.kind === "webhook" && <WebhookFields hook={hook} />}

      {value?.kind === "after" && (
        <>
          <select
            aria-label="Source pipeline"
            className={`${fieldClass} w-auto`}
            value={value.pipelineId ?? ""}
            onChange={(e) => onChange({ ...value, pipelineId: e.target.value })}
          >
            {pipelines.length === 0 && <option value="">no pipelines available</option>}
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="On outcome"
            className={`${fieldClass} w-auto`}
            value={value.on ?? "any"}
            onChange={(e) =>
              onChange({ ...value, on: e.target.value as "succeeded" | "failed" | "any" })
            }
          >
            <option value="succeeded">on succeeded</option>
            <option value="failed">on failed</option>
            <option value="any">on any outcome</option>
          </select>
        </>
      )}
    </div>
  );
}

/** The hook URL, its token, copy buttons and a Rotate action — or, before the
 *  first save, a hint that saving mints them. */
function WebhookFields({ hook }: { hook?: HookCredential }) {
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  if (!hook) {
    return (
      <span className="text-xs opacity-60">Save the pipeline/schedule to get a hook URL.</span>
    );
  }

  const copy = async (what: "url" | "token", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
    } catch {
      // Clipboard access can be denied (insecure context, permissions); the
      // value is still selectable/visible in the field either way.
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <code className="max-w-[18rem] truncate rounded border border-line bg-ground-2 px-1.5 py-1">
        {hook.url}
      </code>
      <button
        type="button"
        className="rounded border border-line px-1.5 py-0.5 hover:bg-ground-2"
        onClick={() => void copy("url", hook.url)}
      >
        {copied === "url" ? "Copied" : "Copy URL"}
      </button>
      <code className="max-w-[10rem] truncate rounded border border-line bg-ground-2 px-1.5 py-1">
        {hook.token}
      </code>
      <button
        type="button"
        className="rounded border border-line px-1.5 py-0.5 hover:bg-ground-2"
        onClick={() => void copy("token", hook.token)}
      >
        {copied === "token" ? "Copied" : "Copy token"}
      </button>
      <button
        type="button"
        disabled={rotating || hook.rotating}
        className="rounded border border-fail/30 px-1.5 py-0.5 text-fail hover:bg-fail/10 disabled:opacity-50"
        onClick={async () => {
          if (
            !confirm(
              "Rotating invalidates the current token — anything already configured with it will stop working.",
            )
          ) {
            return;
          }
          setRotating(true);
          try {
            await hook.onRotate();
          } finally {
            setRotating(false);
          }
        }}
      >
        {rotating || hook.rotating ? "Rotating…" : "Rotate token"}
      </button>
    </div>
  );
}
