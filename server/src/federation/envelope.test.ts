import test from "node:test";
import assert from "node:assert/strict";
import {
  createNonceCache,
  EnvelopeError,
  MAX_SKEW_MS,
  newSecret,
  open,
  seal,
  type Envelope,
} from "./envelope.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const SECRET = "a".repeat(64);

test("a sealed payload round-trips", () => {
  const e = seal({ hello: "world", n: 1 }, SECRET, "machine-a", NOW);
  assert.deepEqual(open(e, SECRET, { now: NOW }), { hello: "world", n: 1 });
  assert.equal(e.from, "machine-a");
  assert.equal(e.v, 1);
});

test("the payload is not readable without the secret", () => {
  const e = seal({ token: "hunter2" }, SECRET, "machine-a", NOW);
  // The whole point of sealing rather than trusting the transport.
  assert.equal(Buffer.from(e.ct, "base64").toString("utf8").includes("hunter2"), false);
  assert.throws(() => open(e, "b".repeat(64), { now: NOW }), EnvelopeError);
});

test("regression: a tampered header is rejected, not just a tampered body", () => {
  const e = seal({ ok: true }, SECRET, "machine-a", NOW);
  // GCM's tag covers the ciphertext but nothing else. Without the outer HMAC,
  // an attacker could rewrite `from` and the summary would be attributed to a
  // different machine.
  assert.throws(() => open({ ...e, from: "machine-b" }, SECRET, { now: NOW }), /signature/);
  const shifted = new Date(NOW.getTime() + 1000).toISOString();
  assert.throws(() => open({ ...e, at: shifted }, SECRET, { now: NOW }), /signature/);
  assert.throws(() => open({ ...e, nonce: "AAAA" }, SECRET, { now: NOW }), /signature/);
});

test("a tampered ciphertext is rejected", () => {
  const e = seal({ ok: true }, SECRET, "machine-a", NOW);
  const bytes = Buffer.from(e.ct, "base64");
  bytes[0] ^= 0xff;
  const tampered: Envelope = { ...e, ct: bytes.toString("base64") };
  // The signature covers ct, so this fails there first — which is the correct
  // order: nothing derived from the envelope is used before it verifies.
  assert.throws(() => open(tampered, SECRET, { now: NOW }), EnvelopeError);
});

test("an envelope outside the freshness window is rejected in both directions", () => {
  const e = seal({ ok: true }, SECRET, "machine-a", NOW);
  const late = new Date(NOW.getTime() + MAX_SKEW_MS + 1000);
  assert.throws(() => open(e, SECRET, { now: late }), /freshness/);
  // A far-future timestamp is as much a replay tell as a stale one: accepting
  // it would let a captured envelope be held and released later.
  const early = new Date(NOW.getTime() - MAX_SKEW_MS - 1000);
  assert.throws(() => open(e, SECRET, { now: early }), /freshness/);
  // Inside the window is fine.
  assert.ok(open(e, SECRET, { now: new Date(NOW.getTime() + MAX_SKEW_MS - 1000) }));
});

test("regression: replaying a valid envelope is caught", () => {
  const cache = createNonceCache();
  const e = seal({ ok: true }, SECRET, "machine-a", NOW);
  const seen = (nonce: string) => cache.check(nonce, NOW);
  assert.ok(open(e, SECRET, { now: NOW, seen }));
  // Without this, a captured good response freezes a peer at a healthy moment
  // for anyone who saw one.
  assert.throws(() => open(e, SECRET, { now: NOW, seen }), /replayed/);
});

test("the nonce cache forgets anything already too old to accept", () => {
  const cache = createNonceCache();
  assert.equal(cache.check("n1", NOW), false);
  assert.equal(cache.size(), 1);
  // Past the freshness window the timestamp check rejects it anyway, so keeping
  // the nonce is a memory leak with a network-controlled key.
  const later = new Date(NOW.getTime() + MAX_SKEW_MS + 1000);
  assert.equal(cache.check("n2", later), false);
  assert.equal(cache.size(), 1);
});

test("a malformed or wrong-version envelope is rejected by name", () => {
  assert.throws(() => open(null, SECRET, { now: NOW }), /version/);
  assert.throws(() => open({ v: 99 }, SECRET, { now: NOW }), /version 99/);
  assert.throws(() => open({ v: 1 }, SECRET, { now: NOW }), /missing from/);
  const e = seal({ ok: true }, SECRET, "a", NOW);
  assert.throws(() => open({ ...e, sig: "" }, SECRET, { now: NOW }), /missing sig/);
});

test("a signature of the wrong length does not throw its way past the check", () => {
  const e = seal({ ok: true }, SECRET, "a", NOW);
  // timingSafeEqual throws on differing lengths; leaking that as an exception
  // path would be both a crash and a length oracle.
  assert.throws(() => open({ ...e, sig: "AAAA" }, SECRET, { now: NOW }), /signature/);
});

test("two secrets derive independent keys", () => {
  const a = seal({ ok: true }, newSecret(), "a", NOW);
  const b = seal({ ok: true }, newSecret(), "a", NOW);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.sig, b.sig);
});

test("every envelope is unique, even for identical payloads", () => {
  const a = seal({ ok: true }, SECRET, "a", NOW);
  const b = seal({ ok: true }, SECRET, "a", NOW);
  // A deterministic envelope would make traffic analysis trivial and would
  // break replay detection, which keys off the nonce.
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test("a fresh secret is 32 bytes of hex", () => {
  const s = newSecret();
  assert.match(s, /^[0-9a-f]{64}$/);
  assert.notEqual(s, newSecret());
});
