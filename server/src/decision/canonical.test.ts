import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalDigest,
  canonicalJson,
  CanonicalJsonError,
  parseCanonical,
  sha256Hex,
} from "./canonical.js";

/** Assert `value` is refused with a CanonicalJsonError naming `pointer`. */
function refuses(value: unknown, pointer: string, reason?: RegExp): void {
  assert.throws(
    () => canonicalJson(value),
    (err: unknown) => {
      assert.ok(
        err instanceof CanonicalJsonError,
        `expected CanonicalJsonError, got ${String(err)}`,
      );
      assert.equal(err.pointer, pointer);
      assert.equal(err.name, "CanonicalJsonError");
      if (reason) assert.match(err.message, reason);
      return true;
    },
  );
}

// ── key order ────────────────────────────────────────────────────────────────

test("canonicalJson sorts keys at every depth", () => {
  const text = canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } });
  assert.equal(text, '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
});

test("canonicalJson orders keys by UTF-16 code unit, not code point or locale", () => {
  // U+1F600 is the surrogate pair D83D DE00, so in code-unit order it sorts
  // BEFORE U+FF5E, although its code point is larger.
  const obj = { "～": 1, "\u{1F600}": 2, é: 3, B: 4, a: 5, b: 6 };
  const keys = Object.keys(JSON.parse(canonicalJson(obj)) as object);
  assert.deepEqual(keys, ["B", "a", "b", "é", "\u{1F600}", "～"]);
});

test("insertion order does not change the encoding", () => {
  const one: Record<string, unknown> = {};
  one.a = 1;
  one.b = { x: 1, y: 2 };
  one.c = [1, { p: 1, q: 2 }];
  const two: Record<string, unknown> = {};
  two.c = [1, { q: 2, p: 1 }];
  two.b = { y: 2, x: 1 };
  two.a = 1;
  assert.equal(canonicalJson(one), canonicalJson(two));
  assert.deepEqual(Object.keys(one), ["a", "b", "c"]);
  assert.deepEqual(Object.keys(two), ["c", "b", "a"]);
});

test("array order is preserved", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

// ── refusals ─────────────────────────────────────────────────────────────────

test("undefined is refused at the top level and nested", () => {
  refuses(undefined, "", /undefined/);
  refuses({ a: undefined }, "/a", /undefined/);
  refuses({ a: [1, { b: undefined }] }, "/a/1/b");
  refuses([undefined], "/0");
});

test("the pointer names the location, e.g. /a/0/b", () => {
  refuses({ a: [{ b: Number.NaN }] }, "/a/0/b", /non-finite/);
});

test("keys with / and ~ are escaped in the pointer", () => {
  refuses({ "a/b": { "c~d": undefined } }, "/a~1b/c~0d");
});

test("functions, symbols and bigints are refused", () => {
  refuses(() => 1, "", /function/);
  refuses({ f() {} }, "/f");
  refuses(Symbol("s"), "", /symbol/);
  refuses({ s: Symbol.iterator }, "/s");
  refuses(10n, "", /bigint/);
  refuses({ n: [1n] }, "/n/0");
});

test("NaN, Infinity, -Infinity are refused", () => {
  refuses(Number.NaN, "", /non-finite/);
  refuses(Number.POSITIVE_INFINITY, "", /non-finite/);
  refuses(Number.NEGATIVE_INFINITY, "", /non-finite/);
  refuses([1, Number.POSITIVE_INFINITY], "/1");
});

test("negative zero is refused, positive zero is accepted", () => {
  refuses(-0, "", /negative zero/);
  refuses({ z: -0 }, "/z");
  assert.equal(canonicalJson(0), "0");
});

test("a sparse array hole is refused, at the hole's index", () => {
  // eslint-disable-next-line no-sparse-arrays
  refuses([1, , 3], "/1", /sparse/);
  const holey = new Array<number>(3);
  holey[0] = 1;
  refuses({ a: holey }, "/a/1");
  refuses(new Array<number>(1), "/0");
});

test("an array with an extra named property is refused", () => {
  const arr: unknown[] = [1, 2];
  (arr as unknown as Record<string, unknown>).extra = true;
  refuses(arr, "", /extra properties/);
  refuses({ a: arr }, "/a");
});

test("an array subclass is refused", () => {
  class Sub extends Array<number> {}
  refuses(Sub.from([1, 2]), "", /array subclass/);
});

test("Date, Map, Set, RegExp, class instances and typed arrays are refused", () => {
  refuses(new Date(0), "", /not a plain object/);
  refuses({ d: new Date(0) }, "/d");
  refuses(new Map([["a", 1]]), "");
  refuses(new Set([1]), "");
  refuses(/x/, "");
  class Point {
    x = 1;
  }
  refuses(new Point(), "", /not a plain object/);
  refuses({ p: new Point() }, "/p");
  refuses(Buffer.from("abc"), "");
  refuses(new Uint8Array([1, 2, 3]), "");
  refuses({ bytes: new Uint8Array(2) }, "/bytes");
});

test("an object with an accessor property is refused, even if it returns a plain value", () => {
  const obj = {
    get a() {
      return 1;
    },
  };
  refuses(obj, "/a", /accessor/);
  const setterOnly = Object.defineProperty({}, "s", {
    set() {},
    enumerable: true,
    configurable: true,
  });
  refuses(setterOnly, "/s", /accessor/);
});

test("an object with a non-enumerable own property is refused", () => {
  const obj = { visible: 1 };
  Object.defineProperty(obj, "hidden", { value: 2, enumerable: false });
  refuses(obj, "/hidden", /non-enumerable/);
  refuses({ nested: obj }, "/nested/hidden");
});

test("an object with a symbol key is refused", () => {
  refuses({ [Symbol("k")]: 1 }, "", /symbol key/);
  refuses({ a: { [Symbol.for("k")]: 1 } }, "/a");
});

test("a cycle is refused, a shared (acyclic) reference is not", () => {
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = cyc;
  refuses(cyc, "/self", /cycle/);
  const arr: unknown[] = [];
  arr.push({ back: arr });
  refuses(arr, "/0/back");

  const shared = { v: 1 };
  assert.equal(
    canonicalJson({ a: shared, b: shared, c: [shared, shared] }),
    canonicalJson({
      a: { v: 1 },
      b: { v: 1 },
      c: [{ v: 1 }, { v: 1 }],
    }),
  );
});

function nested(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

test("nesting deeper than 64 is refused; 64 levels are accepted", () => {
  const ok = canonicalJson(nested(64));
  assert.equal(ok, `${"[".repeat(64)}1${"]".repeat(64)}`);
  assert.throws(
    () => canonicalJson(nested(65)),
    (err: unknown) => {
      assert.ok(err instanceof CanonicalJsonError);
      assert.match(err.message, /too deep/);
      assert.equal(err.pointer, "/0".repeat(64));
      return true;
    },
  );
  let obj: unknown = 1;
  for (let i = 0; i < 65; i++) obj = { k: obj };
  assert.throws(() => canonicalJson(obj), CanonicalJsonError);
});

test("the error message names the pointer, and '/' for the root", () => {
  assert.throws(() => canonicalJson(undefined), /not canonical JSON at \/: undefined/);
  assert.throws(() => canonicalJson({ a: undefined }), /not canonical JSON at \/a: undefined/);
});

// ── acceptance and round-trip ────────────────────────────────────────────────

test("null-prototype objects, empty containers and primitives are accepted", () => {
  const bare = Object.create(null) as Record<string, unknown>;
  bare.b = 1;
  bare.a = Object.create(null);
  assert.equal(canonicalJson(bare), '{"a":{},"b":1}');
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(false), "false");
  assert.equal(canonicalJson("x"), '"x"');
});

test("lone surrogates and non-ASCII strings round-trip", () => {
  const value = {
    lone: "a\uD800b",
    lowLone: "\uDC00",
    pair: "\u{1F600}",
    accents: "héllo wörld — 日本語",
    controls: 'quote" back\\ nl\n tab\t nul\u0000',
    "key\uD800": "v",
  };
  const text = canonicalJson(value);
  assert.ok(
    !/[\uD800-\uDFFF]/.test(text.replace(/\u{1F600}/gu, "")),
    "lone surrogates are escaped",
  );
  const parsed = JSON.parse(text) as unknown;
  assert.deepEqual(parsed, value);
  assert.equal(canonicalJson(parsed), text);
});

test("integers and floats round-trip with identical text on re-encode", () => {
  const value = [
    0,
    1,
    -1,
    42,
    1e21,
    1e-7,
    0.1,
    0.1 + 0.2,
    -3.5,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_VALUE,
    5e-324,
  ];
  const text = canonicalJson(value);
  const parsed = JSON.parse(text) as unknown;
  assert.deepEqual(parsed, value);
  assert.equal(canonicalJson(parsed), text);
});

test("a mixed document parses back deep-equal and re-encodes identically", () => {
  const value = {
    z: [1, 2.5, "s", null, true, { b: [], a: {} }],
    a: { nested: { deep: ["x", { k: "v" }] } },
    n: null,
  };
  const text = canonicalJson(value);
  const parsed = JSON.parse(text) as unknown;
  assert.deepEqual(parsed, value);
  assert.equal(canonicalJson(parsed), text);
});

test("an own __proto__ key parsed from JSON text is encoded and round-trips", () => {
  const parsed = JSON.parse('{"a":2,"__proto__":{"x":1}}') as Record<string, unknown>;
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, "__proto__"));
  const text = canonicalJson(parsed);
  assert.equal(text, '{"__proto__":{"x":1},"a":2}');
  const again = JSON.parse(text) as Record<string, unknown>;
  assert.ok(Object.prototype.hasOwnProperty.call(again, "__proto__"));
  assert.deepEqual(again, parsed);
  assert.equal(canonicalJson(again), text);
  assert.equal(parseCanonical(text) !== null, true);
});

// ── digest ───────────────────────────────────────────────────────────────────

test("canonicalDigest is sha256 over the UTF-8 bytes of the text", () => {
  const value = { b: 2, a: "ok" };
  const d = canonicalDigest(value);
  assert.equal(d.text, canonicalJson(value));
  assert.equal(d.sha256, createHash("sha256").update(Buffer.from(d.text, "utf8")).digest("hex"));
  assert.match(d.sha256, /^[0-9a-f]{64}$/);
  assert.equal(d.bytes, Buffer.byteLength(d.text, "utf8"));
});

test("canonicalDigest bytes is the UTF-8 length, not the string length", () => {
  const d = canonicalDigest({ s: "é—\u{1F600}" });
  assert.ok(d.bytes > d.text.length);
  // {"s":"é—😀"}: 8 ASCII-range chars + é(2) + —(3) + 😀(4)
  assert.equal(d.bytes, 8 + 2 + 3 + 4);
});

test("canonicalDigest is insensitive to key order and sensitive to content", () => {
  assert.equal(canonicalDigest({ a: 1, b: 2 }).sha256, canonicalDigest({ b: 2, a: 1 }).sha256);
  assert.notEqual(canonicalDigest({ a: 1 }).sha256, canonicalDigest({ a: 2 }).sha256);
});

test("canonicalDigest refuses what canonicalJson refuses", () => {
  assert.throws(() => canonicalDigest({ a: undefined }), CanonicalJsonError);
});

test("sha256Hex hashes strings and bytes the same way", () => {
  assert.equal(sha256Hex("abc"), sha256Hex(Buffer.from("abc")));
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

// ── parseCanonical ───────────────────────────────────────────────────────────

test("parseCanonical accepts canonical text", () => {
  const text = canonicalJson({ b: [1, 2], a: "x" });
  assert.deepEqual(parseCanonical(text), { a: "x", b: [1, 2] });
  assert.equal(parseCanonical("null"), null);
  assert.deepEqual(parseCanonical("[]"), []);
});

test("parseCanonical refuses a different key order", () => {
  assert.throws(() => parseCanonical('{"b":1,"a":2}'), /not in canonical form/);
});

test("parseCanonical refuses extra whitespace", () => {
  assert.throws(() => parseCanonical('{"a": 1}'), /not in canonical form/);
  assert.throws(() => parseCanonical(' {"a":1}'), /not in canonical form/);
  assert.throws(() => parseCanonical('{"a":1}\n'), /not in canonical form/);
  assert.throws(() => parseCanonical("[1, 2]"), /not in canonical form/);
});

test("parseCanonical refuses text that is not JSON", () => {
  assert.throws(() => parseCanonical("{nope"), SyntaxError);
});

test("parseCanonical refuses non-canonical number forms", () => {
  assert.throws(() => parseCanonical("1.0"), /not in canonical form/);
  assert.throws(() => parseCanonical("1e2"), /not in canonical form/);
});
