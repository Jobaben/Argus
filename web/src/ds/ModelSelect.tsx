import { useId, useState } from "react";
import { labelClass } from "./controls";

const CLAUDE_ALIASES = ["opus", "sonnet", "haiku"];

/** Title Case for an alias, so "sonnet" reads as "Sonnet" and a model id with
 *  digits or dots ("gpt-5.3-codex") is left exactly as the operator typed it. */
function aliasLabel(alias: string): string {
  return /^[a-z]+$/.test(alias) ? alias[0].toUpperCase() + alias.slice(1) : alias;
}

/**
 * Model picker: the runtime's aliases, a custom-id escape hatch, or "" = inherit
 * the CLI default (onChange gets undefined). Shared by the pipeline form, the
 * scheduler and the Launch tab.
 *
 * `aliases` comes from the selected runtime. Claude Code has three stable
 * shorthands worth offering; Codex's catalogue is account-dependent and moves
 * faster than any hardcoded list, so it ships empty and the free-text field
 * carries the weight. That is why the custom option is always present rather
 * than being a fallback for when the list is short.
 *
 * `caption` puts a visible label above the picker and lets it fill its column,
 * for a form laid out in a grid. Without it the picker is the bare inline
 * control a dense row of selects wants, named only by `label` — which is still
 * the inherit option's text and the accessible name either way, so a chosen
 * value never leaves the field without saying what it is to a screen reader.
 */
export function ModelSelect({
  label,
  ariaLabel,
  caption,
  value,
  onChange,
  fieldClass,
  aliases = CLAUDE_ALIASES,
}: {
  label: string;
  ariaLabel?: string;
  caption?: string;
  value?: string;
  onChange: (v: string | undefined) => void;
  fieldClass: string;
  aliases?: string[];
}) {
  const id = useId();
  const isCustom = !!value && !aliases.includes(value);
  const [custom, setCustom] = useState(isCustom);
  const selectValue = custom ? "custom" : (value ?? "");
  const control = (
    <div className={caption ? "flex min-w-0 flex-col gap-1.5" : "flex items-center gap-1"}>
      <select
        id={caption ? id : undefined}
        aria-label={ariaLabel ?? label}
        className={`${fieldClass} ${caption ? "w-full" : "w-auto"}`}
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "custom") {
            setCustom(true);
            onChange(undefined);
          } else {
            setCustom(false);
            onChange(v === "" ? undefined : v);
          }
        }}
      >
        <option value="">{label}</option>
        {aliases.map((a) => (
          <option key={a} value={a}>
            {aliasLabel(a)}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {custom && (
        <input
          className={`${fieldClass} ${caption ? "w-full" : "w-40"} font-mono`}
          aria-label={`Custom model id (${ariaLabel ?? label})`}
          placeholder="model id"
          value={isCustom ? value : ""}
          onChange={(e) => {
            const t = e.target.value.trim();
            onChange(t === "" ? undefined : t);
          }}
        />
      )}
    </div>
  );
  if (!caption) return control;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {caption}
      </label>
      {control}
    </div>
  );
}
