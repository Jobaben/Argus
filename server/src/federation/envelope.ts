import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * The wire format between paired machines: encrypted, signed, and fresh.
 *
 * Peers talk over whatever network the user has — a LAN, a Tailscale tailnet, a
 * reverse proxy. Argus cannot assume any of it is private, so a peer summary is
 * sealed end-to-end rather than trusting the transport. That also means TLS is
 * an improvement rather than a requirement, which matters because "set up
 * certificates between your laptop and your build box" is the step at which a
 * feature like this stops being used.
 *
 * The construction is deliberately boring, built only from `node:crypto`:
 *
 * - **HKDF-SHA256** derives two independent keys from the pairing secret — one
 *   for encryption, one for the MAC. Using one secret for both is the classic
 *   way to make two sound primitives unsound together.
 * - **AES-256-GCM** encrypts. GCM authenticates its own ciphertext.
 * - **HMAC-SHA256 over the whole envelope** signs it. GCM's tag already covers
 *   the ciphertext, so this is not about confidentiality: it binds the *header*
 *   — version, sender, timestamp, nonce — so none of it can be edited in
 *   flight, and it is the field a reader can point at when the docs say
 *   "signed".
 * - **A timestamp and a nonce** make replay detectable. Without them a captured
 *   envelope stays valid forever, which for a summary means a peer can be
 *   frozen at a healthy moment by anyone who saw one good response.
 *
 * Nothing here rolls its own cryptography; the care is in the composition and
 * in the failure mode, which is always "reject", never "accept with a warning".
 */

/** Bump if the format changes. A mismatch is rejected, never guessed at. */
export const ENVELOPE_VERSION = 1;

/** How far apart two clocks may be before an envelope is considered a replay. */
export const MAX_SKEW_MS = 5 * 60_000;

const KEY_INFO = Buffer.from("argus-federation-v1-encrypt");
const MAC_INFO = Buffer.from("argus-federation-v1-mac");
/** HKDF needs a salt; a fixed, public one is correct here because the secret is
 *  already high-entropy and both sides must derive the same keys with no
 *  round trip to agree on randomness. */
const SALT = Buffer.from("argus-constellation");

export interface Envelope {
  v: number;
  /** Who sealed it. Not trusted until the signature verifies. */
  from: string;
  /** ISO timestamp, covered by the signature. */
  at: string;
  /** Base64 random, unique per envelope. */
  nonce: string;
  iv: string;
  ct: string;
  tag: string;
  sig: string;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

function keysFor(secret: string): { enc: Buffer; mac: Buffer } {
  const ikm = Buffer.from(secret, "utf8");
  return {
    enc: Buffer.from(hkdfSync("sha256", ikm, SALT, KEY_INFO, 32)),
    mac: Buffer.from(hkdfSync("sha256", ikm, SALT, MAC_INFO, 32)),
  };
}

/** The exact bytes the signature covers: every field except the signature. */
function signingInput(e: Omit<Envelope, "sig">): string {
  return [e.v, e.from, e.at, e.nonce, e.iv, e.ct, e.tag].join("|");
}

export function seal(payload: unknown, secret: string, from: string, now: Date): Envelope {
  const { enc, mac } = keysFor(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", enc, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const body: Omit<Envelope, "sig"> = {
    v: ENVELOPE_VERSION,
    from,
    at: now.toISOString(),
    nonce: randomBytes(16).toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  const sig = createHmac("sha256", mac).update(signingInput(body)).digest("base64");
  return { ...body, sig };
}

/** Constant-time compare that cannot throw on a length mismatch. */
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, "base64");
  const right = Buffer.from(b, "base64");
  // `timingSafeEqual` throws on differing lengths, which would leak length via
  // an exception path — compare lengths first, then the bytes.
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface OpenOptions {
  now: Date;
  /** Returns true if this nonce has been seen before, and records it. */
  seen?: (nonce: string) => boolean;
}

export function open<T = unknown>(raw: unknown, secret: string, opts: OpenOptions): T {
  const e = (raw ?? {}) as Partial<Envelope>;
  if (e.v !== ENVELOPE_VERSION) {
    throw new EnvelopeError(`unsupported envelope version ${String(e.v)}`);
  }
  for (const field of ["from", "at", "nonce", "iv", "ct", "tag", "sig"] as const) {
    if (typeof e[field] !== "string" || !e[field]) {
      throw new EnvelopeError(`envelope is missing ${field}`);
    }
  }
  const body = e as Envelope;
  const { enc, mac } = keysFor(secret);

  // Signature first, before anything derived from the envelope is used. Every
  // check below this line is on data a verified sender produced.
  const expected = createHmac("sha256", mac).update(signingInput(body)).digest("base64");
  if (!equal(expected, body.sig)) throw new EnvelopeError("signature does not verify");

  const at = Date.parse(body.at);
  if (!Number.isFinite(at)) throw new EnvelopeError("envelope has no usable timestamp");
  // Skew is checked in both directions. A far-future timestamp is as much a
  // replay tell as a stale one, and accepting it would let a captured envelope
  // be held and released later.
  if (Math.abs(opts.now.getTime() - at) > MAX_SKEW_MS) {
    throw new EnvelopeError("envelope is outside the freshness window");
  }
  if (opts.seen?.(body.nonce)) throw new EnvelopeError("envelope replayed");

  try {
    const decipher = createDecipheriv("aes-256-gcm", enc, Buffer.from(body.iv, "base64"));
    decipher.setAuthTag(Buffer.from(body.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(body.ct, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    // The GCM tag failing after a valid HMAC means a truncated or corrupted
    // body, not an attack we can say anything more useful about.
    throw new EnvelopeError("envelope did not decrypt");
  }
}

/**
 * A bounded set of recently-seen nonces.
 *
 * Bounded by the freshness window rather than by count: anything older than the
 * window is already rejected on its timestamp, so remembering it is pointless,
 * and an unbounded set is a memory leak with a network-controlled key.
 */
export function createNonceCache(windowMs = MAX_SKEW_MS) {
  const seen = new Map<string, number>();
  return {
    check(nonce: string, now: Date): boolean {
      const cutoff = now.getTime() - windowMs;
      for (const [key, at] of seen) if (at < cutoff) seen.delete(key);
      if (seen.has(nonce)) return true;
      seen.set(nonce, now.getTime());
      return false;
    },
    size: () => seen.size,
  };
}

/** A new pairing secret. 32 bytes of randomness, hex for copy-paste. */
export function newSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * A public identifier for a pairing, derived from its secret.
 *
 * The caller has to tell the responder *which* pairing it is using, or the
 * responder cannot know which key to seal with. Sending the secret itself would
 * defeat the point, and sending the caller's own peer id does not work: that id
 * is local to the caller's list and means nothing on the other machine.
 *
 * Hashing the shared secret gives both sides the same name for the pairing
 * without either revealing it. It is a lookup key and nothing more — it grants
 * no access, because every byte of the exchange still has to verify against the
 * secret it names.
 */
export function pairingId(secret: string): string {
  return createHmac("sha256", Buffer.from("argus-pairing-id"))
    .update(secret)
    .digest("hex")
    .slice(0, 32);
}
