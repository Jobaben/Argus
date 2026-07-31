import { useState } from "react";

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
 */
export function ModelSelect({
  label,
  ariaLabel,
  value,
  onChange,
  fieldClass,
  aliases = CLAUDE_ALIASES,
}: {
  label: string;
  ariaLabel?: string;
  value?: string;
  onChange: (v: string | undefined) => void;
  fieldClass: string;
  aliases?: string[];
}) {
  const isCustom = !!value && !aliases.includes(value);
  const [custom, setCustom] = useState(isCustom);
  const selectValue = custom ? "custom" : (value ?? "");
  return (
    <div className="flex items-center gap-1">
      <select
        aria-label={ariaLabel ?? label}
        className={`${fieldClass} w-auto`}
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
          className={`${fieldClass} w-40`}
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
}
