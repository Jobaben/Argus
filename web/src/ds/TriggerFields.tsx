import { useState } from "react";
import type { Trigger } from "../types";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { useConfirm } from "./useConfirm";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The words between the controls. The trigger reads as one sentence —
 *  "Weekly on Mon at 02:00", "every 60 min" — so each field is named by the
 *  clause it sits in rather than by a caption over a bare box. */
const JOIN = "text-caption text-ink-faint";

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
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
      <select
        aria-label="Trigger"
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
        <option value="interval">On an interval</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        {allowWindowed && <option value="windowed">During a daily window</option>}
        <option value="webhook">On a webhook call</option>
        <option value="after">After a pipeline</option>
      </select>

      {value?.kind === "interval" && (
        <>
          <span className={JOIN}>every</span>
          <input
            type="number"
            min={1}
            aria-label="Interval in minutes"
            className={`${fieldClass} w-24`}
            value={value.everyMinutes ?? 60}
            onChange={(e) => onChange({ kind: "interval", everyMinutes: Number(e.target.value) })}
          />
          <span className={JOIN}>min</span>
        </>
      )}
      {value?.kind === "weekly" && (
        <>
          <span className={JOIN}>on</span>
          <select
            aria-label="Weekday"
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
        </>
      )}
      {(value?.kind === "daily" || value?.kind === "weekly") && (
        <>
          <span className={JOIN}>at</span>
          <input
            type="time"
            aria-label="Time of day"
            className={`${fieldClass} w-32`}
            value={value.time ?? "02:00"}
            onChange={(e) => onChange({ ...value, time: e.target.value })}
          />
        </>
      )}
      {value?.kind === "windowed" && (
        <>
          <span className={JOIN}>from</span>
          <input
            type="time"
            aria-label="Window start"
            className={`${fieldClass} w-32`}
            value={value.startTime ?? "09:00"}
            onChange={(e) => onChange({ ...value, startTime: e.target.value })}
          />
          <span className={JOIN}>to</span>
          <input
            type="time"
            aria-label="Window end"
            className={`${fieldClass} w-32`}
            value={value.endTime ?? "17:00"}
            onChange={(e) => onChange({ ...value, endTime: e.target.value })}
          />
          <span className={JOIN}>every</span>
          <input
            type="number"
            min={1}
            aria-label="Cadence minutes"
            className={`${fieldClass} w-20`}
            value={value.everyMinutes ?? 30}
            onChange={(e) => onChange({ ...value, everyMinutes: Number(e.target.value) })}
          />
          <span className={JOIN}>min</span>
          {/* A pressed day is lifted and lit, an unpressed one recedes — the
              pressed state used to be bold-versus-dimmed, which on a row of
              three-letter words was hard to read at a glance. */}
          <div className="flex basis-full flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Days the window opens"
              className="inline-flex flex-wrap items-center gap-0.5 rounded-control border border-line bg-ground-2 p-0.5"
            >
              {DAYS.map((d, i) => {
                const on = (value.weekdays ?? []).includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-label={d}
                    aria-pressed={on}
                    className={`h-7 rounded-md px-2 text-caption font-semibold transition duration-(--duration-quick) motion-safe:active:scale-[0.96] ${
                      on
                        ? "bg-eye/15 text-eye ring-1 ring-inset ring-eye/30"
                        : "text-ink-faint hover:bg-surface-2 hover:text-ink"
                    }`}
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
            <span className={JOIN}>
              {(value.weekdays ?? []).length === 0 ? "every day" : "only on these days"}
            </span>
          </div>
        </>
      )}

      {value?.kind === "webhook" && <WebhookFields hook={hook} />}

      {value?.kind === "after" && (
        <>
          <select
            aria-label="Source pipeline"
            className={`${fieldClass} w-auto max-w-full`}
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
 *  first save, a hint that saving mints them. Always a row of its own: a URL
 *  and a token are too long to share a line with the trigger picker. */
function WebhookFields({ hook }: { hook?: HookCredential }) {
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);
  const confirm = useConfirm();

  if (!hook) {
    return (
      <p className="flex basis-full items-center gap-1.5 text-caption text-ink-faint">
        <Icon name="info" size={14} />
        Save the pipeline/schedule to get a hook URL.
      </p>
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

  const busy = rotating || hook.rotating;
  const rotate = async () => {
    setRotating(true);
    try {
      await hook.onRotate();
    } finally {
      setRotating(false);
    }
  };
  const valueClass =
    "min-w-0 flex-1 truncate rounded-md border border-line bg-ground px-2 py-1 font-mono text-caption text-ink-dim";

  return (
    <div className="grid basis-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-control border border-line bg-ground-2/60 p-3">
      <span className="eyebrow">URL</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className={valueClass} title={hook.url}>
          {hook.url}
        </code>
        <Button
          size="sm"
          icon={copied === "url" ? "check" : "copy"}
          onClick={() => void copy("url", hook.url)}
        >
          {copied === "url" ? "Copied" : "Copy URL"}
        </Button>
      </div>
      <span className="eyebrow">Token</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className={valueClass}>{hook.token}</code>
        <Button
          size="sm"
          icon={copied === "token" ? "check" : "copy"}
          onClick={() => void copy("token", hook.token)}
        >
          {copied === "token" ? "Copied" : "Copy token"}
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon="retry"
          disabled={busy}
          aria-expanded={confirm.armed === "rotate"}
          onClick={confirm.toggle("rotate")}
        >
          {busy ? "Rotating…" : "Rotate token"}
        </Button>
      </div>
      {/* Across both columns: the token's column alone is narrow on a phone. */}
      {confirm.armed === "rotate" && (
        <div className="col-span-2">
          {confirm.question(
            {
              title: "Rotate the webhook token?",
              detail:
                "This invalidates the current token — anything already configured with it will stop working.",
              confirm: "Rotate now",
              cancel: "Keep token",
              icon: "retry",
            },
            () => void rotate(),
          )}
        </div>
      )}
    </div>
  );
}
