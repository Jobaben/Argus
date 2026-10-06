import { createHash } from "node:crypto";

/**
 * Strict canonical JSON for the Decision Plane (RFC §O.3).
 *
 * `JSON.stringify` is not a canonical form: key order is insertion order, and
 * it silently alters values it cannot represent — `undefined` properties
 * vanish, `NaN`/`Infinity` become `null`, `-0` becomes `0`, a `Date` becomes a
 * string, a class instance loses its prototype. A hash over such output can
 * describe an input the caller never had.
 *
 * This encoder therefore **refuses** every value whose JSON form would not
 * round-trip to the same value, instead of coercing it:
 *
 * - accepted: `null`, booleans, strings, finite numbers other than `-0`,
 *   dense arrays, and plain objects (prototype `Object.prototype` or `null`)
 *   whose own properties are enumerable string-keyed data properties;
 * - refused: `undefined`, functions, symbols, bigints, non-finite numbers,
 *   `-0`, sparse arrays, accessors, symbol keys, non-plain objects (Date, Map,
 *   Buffer, class instances), cycles, and nesting deeper than 64.
 *
 * Keys are sorted by UTF-16 code unit (the default `Array#sort` order), which
 * is total and locale-independent. Strings and numbers use `JSON.stringify`'s
 * own encoding: ECMAScript's Number-to-String is exactly specified (shortest
 * round-tripping digits), and well-formed stringify escapes lone surrogates,
 * so both are deterministic and parse back to the identical value.
 */

export class CanonicalJsonError extends Error {
  constructor(
    readonly pointer: string,
    reason: string,
  ) {
    super(`not canonical JSON at ${pointer || "/"}: ${reason}`);
    this.name = "CanonicalJsonError";
  }
}

const MAX_DEPTH = 64;

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function encode(value: unknown, pointer: string, depth: number, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(pointer, "non-finite number");
      if (Object.is(value, -0)) throw new CanonicalJsonError(pointer, "negative zero");
      return JSON.stringify(value);
    case "undefined":
      throw new CanonicalJsonError(pointer, "undefined");
    case "bigint":
      throw new CanonicalJsonError(pointer, "bigint");
    case "function":
      throw new CanonicalJsonError(pointer, "function");
    case "symbol":
      throw new CanonicalJsonError(pointer, "symbol");
  }
  const obj = value as object;
  if (depth >= MAX_DEPTH) throw new CanonicalJsonError(pointer, "nesting too deep");
  if (stack.has(obj)) throw new CanonicalJsonError(pointer, "cycle");
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      if (Object.getPrototypeOf(obj) !== Array.prototype) {
        throw new CanonicalJsonError(pointer, "array subclass");
      }
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(obj, i)) {
          throw new CanonicalJsonError(`${pointer}/${i}`, "sparse array hole");
        }
        parts.push(encode(obj[i], `${pointer}/${i}`, depth + 1, stack));
      }
      if (Reflect.ownKeys(obj).length !== obj.length + 1) {
        throw new CanonicalJsonError(pointer, "array with extra properties");
      }
      return `[${parts.join(",")}]`;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(pointer, "not a plain object");
    }
    const keys = Reflect.ownKeys(obj);
    const names: string[] = [];
    for (const key of keys) {
      if (typeof key === "symbol") throw new CanonicalJsonError(pointer, "symbol key");
      const desc = Object.getOwnPropertyDescriptor(obj, key)!;
      if (!("value" in desc)) {
        throw new CanonicalJsonError(`${pointer}/${escapePointer(key)}`, "accessor property");
      }
      if (!desc.enumerable) {
        throw new CanonicalJsonError(`${pointer}/${escapePointer(key)}`, "non-enumerable property");
      }
      names.push(key);
    }
    names.sort();
    const parts = names.map((key) => {
      const v = (obj as Record<string, unknown>)[key];
      return `${JSON.stringify(key)}:${encode(v, `${pointer}/${escapePointer(key)}`, depth + 1, stack)}`;
    });
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(obj);
  }
}

/** Encode a value canonically, or throw `CanonicalJsonError`. */
export function canonicalJson(value: unknown): string {
  return encode(value, "", 0, new Set());
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The canonical bytes of a value, their sha256 and their length. */
export function canonicalDigest(value: unknown): { text: string; sha256: string; bytes: number } {
  const text = canonicalJson(value);
  const buf = Buffer.from(text, "utf8");
  return { text, sha256: sha256Hex(buf), bytes: buf.length };
}

/** Parse text that must already be canonical: re-encoding must reproduce it exactly. */
export function parseCanonical(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error("text is not in canonical form");
  return value;
}

export const SHA256_RE = /^[0-9a-f]{64}$/;
