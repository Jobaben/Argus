/**
 * The value a route decision turned on, as something readable.
 *
 * A decision carries whatever the phase's result artifact held, and the board
 * used to print it as one `JSON.stringify` line. That is fine for `{"ok":true}`
 * and unreadable for the real thing: an agent handing back a verdict plus six
 * sentences of what it is missing arrives as a 900-character wall of braces and
 * quotes, broken mid-word, burying the step tiles under it.
 *
 * So: a short value stays literal — it is already the clearest form of itself,
 * and a layout around `{"accepted":true}` is ceremony. A long one is taken
 * apart into the fields it is made of, with a list rendered as a list. Pure, and
 * separate from the component, because the shapes worth getting right (a bare
 * string, an array at the top, a nested object, a null) are all data.
 */

/** Serialized values at or under this length read fine on one line. */
export const INLINE_VALUE_CHARS = 72;

export interface DecisionField {
  /** The key the value sat under; null when the value has no shape of its own. */
  key: string | null;
  /** `list` renders as bullets, `line` as one wrapping line. */
  kind: "line" | "list";
  /** The value, when `kind` is `line`. */
  text: string;
  /** The values, when `kind` is `list`. */
  items: string[];
}

/** Whether the value is better shown as fields than as its JSON one-liner. */
export function isLongValue(value: unknown): boolean {
  return (JSON.stringify(value) ?? "").length > INLINE_VALUE_CHARS;
}

/** A leaf as text: a string speaks for itself, anything else keeps its JSON. */
function leafText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function line(key: string | null, value: unknown): DecisionField {
  return { key, kind: "line", text: leafText(value), items: [] };
}

function list(key: string | null, values: unknown[]): DecisionField {
  return { key, kind: "list", text: "", items: values.map(leafText) };
}

/**
 * The fields to render for a decision value. An empty array keeps its JSON
 * rather than rendering as nothing: "no items" and "no value" are different
 * answers and the reader is entitled to tell them apart.
 */
export function decisionFields(value: unknown): DecisionField[] {
  if (Array.isArray(value)) return value.length > 0 ? [list(null, value)] : [line(null, value)];
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [line(null, value)];
    return entries.map(([key, v]) =>
      Array.isArray(v) && v.length > 0 ? list(key, v) : line(key, v),
    );
  }
  return [line(null, value)];
}
