/**
 * Strict canonical JSON for the Decision Plane (RFC §O.3).
 *
 * The encoder lives in `durable/canonical.ts`, shared with the pipeline
 * transition log; it writes nothing and reads nothing, so sharing it gives the
 * plane no access to pipeline state. Re-exported here unchanged so every
 * digest the plane has recorded is computed by the same code.
 */
import {
  CanonicalJsonError,
  canonicalJson,
  sha256Hex,
  canonicalDigest,
  parseCanonical,
  SHA256_RE,
} from "../durable/canonical.js";

export { CanonicalJsonError, canonicalJson, sha256Hex, canonicalDigest, parseCanonical, SHA256_RE };
