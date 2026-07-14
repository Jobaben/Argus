import { useState } from "react";

const MODEL_ALIASES = ["opus", "sonnet", "haiku"];

/** Model picker: the CLI aliases, a custom-id escape hatch, or "" = inherit
 * the CLI default (onChange gets undefined). Shared by the pipeline form and
 * the Launch tab. */
export function ModelSelect({
  label,
  ariaLabel,
  value,
  onChange,
  fieldClass,
}: {
  label: string;
  ariaLabel?: string;
  value?: string;
  onChange: (v: string | undefined) => void;
  fieldClass: string;
}) {
  const isCustom = !!value && !MODEL_ALIASES.includes(value);
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
        <option value="opus">Opus</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
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
