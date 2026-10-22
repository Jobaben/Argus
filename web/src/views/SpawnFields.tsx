import { useId } from "react";
import { labelClass } from "../ds";
import type { SpawnPolicy } from "../types";
import { parseSpawnOptions, spawnOptionsText } from "./spawnAuthoring";

/**
 * A spawn phase's children in the pipeline form (DL-A2): which pipeline each
 * child runs, chosen from a list because ids are UUIDs, and the rest of
 * `spawn` as JSON.
 *
 * JSON rather than a field per setting, for now: the policy names paths into
 * another phase's result, which a form can only offer once it can read that
 * result's schema. The text is the form's, kept as typed — an edit that does
 * not parse stays on screen, says why, and blocks Save — while the policy
 * keeps its last valid value.
 */
export function SpawnFields({
  spawn,
  index,
  pipelines,
  sources,
  fieldClass,
  draft,
  onDraft,
  onChange,
}: {
  spawn: SpawnPolicy;
  index: number;
  /** Every pipeline but this one. */
  pipelines: { id: string; name: string }[];
  /** The phases this one can read its tasks from, nearest first. */
  sources: { id: string; name: string }[];
  fieldClass: string;
  /** The JSON as last typed; absent, the policy's own text. */
  draft: string | undefined;
  onDraft: (text: string) => void;
  onChange: (spawn: SpawnPolicy) => void;
}) {
  const errorId = useId();
  const text = draft ?? spawnOptionsText(spawn);
  const parsed = draft === undefined ? null : parseSpawnOptions(draft);
  const error = parsed && !parsed.ok ? parsed.error : null;
  const { pipelineId } = spawn;
  const listed = pipelines.some((p) => p.id === pipelineId);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <label className="flex min-w-0 max-w-md flex-col gap-1.5">
        <span className={labelClass}>Child pipeline</span>
        <select
          className={`${fieldClass} h-9 w-full`}
          aria-label={`Child pipeline (phase ${index + 1})`}
          value={pipelineId}
          onChange={(e) => onChange({ ...spawn, pipelineId: e.target.value })}
        >
          <option value="">Choose a pipeline</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {pipelineId && !listed && (
            <option value={pipelineId}>{`Unknown pipeline (${pipelineId})`}</option>
          )}
        </select>
        <span className="text-caption text-ink-faint">
          It needs no trigger or a webhook one, and no spawn phase of its own.
        </span>
      </label>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={labelClass}>Task list and options (JSON)</span>
        <textarea
          className={`${fieldClass} min-h-40 w-full resize-y font-mono leading-relaxed`}
          aria-label={`Task list settings (phase ${index + 1})`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            onDraft(e.target.value);
            const next = parseSpawnOptions(e.target.value);
            if (next.ok) onChange({ pipelineId, ...next.options });
          }}
        />
        {error && (
          <span id={errorId} className="text-caption text-fail">
            {error}
          </span>
        )}
        <span className="text-caption text-ink-faint">
          <code>items</code>: the earlier phase whose result holds the task list, and the path to
          it. <code>key</code>: the task field that names each task. Optional:{" "}
          <code>dependsOn</code>, <code>title</code>, <code>maxParallel</code> (1 until parallel
          sessions are safe), <code>maxItems</code> (default 20, at most 50), <code>base</code>,{" "}
          <code>include</code>.
        </span>
      </label>
      <p data-testid="spawn-sources" className="text-caption text-ink-faint">
        {sources.length > 0
          ? `Can read from: ${sources.map((s) => `${s.name} (${s.id})`).join(", ")}`
          : "No earlier phase declares a result yet."}
      </p>
    </div>
  );
}
