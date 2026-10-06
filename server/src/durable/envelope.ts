import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { defaultWrite, writeAll, type WriteFn } from "./io.js";

/**
 * The checksummed line envelope and its torn-write discipline, shared by the
 * Decision Journal (RFC §O.3) and the pipeline transition log.
 *
 * Every record is one line, `canonical({body, kind, sha256})`, its digest over
 * `canonical({body, kind})`. An append first fences off any fragment a crash
 * left at the end of the file and marks it, so a reader can tell a torn write
 * from damage; then writes every byte and fsyncs. These primitives take a path
 * and write only there: they know nothing about what the file is for.
 */

// ── Line envelope ───────────────────────────────────────────────────────────

/** One record: `canonical({body, kind, sha256})`, sha256 over `canonical({body, kind})`. */
export function encodeLine(kind: string, body: unknown): { text: string; digest: string } {
  const digest = sha256Hex(canonicalJson({ body, kind }));
  return { text: `${canonicalJson({ body, kind, sha256: digest })}\n`, digest };
}

export type ParsedLine =
  | { ok: true; line: number; kind: string; body: unknown; digest: string }
  | { ok: false; line: number; problem: "unparseable" | "digest-mismatch" | "malformed" };

export interface ParsedFile {
  lines: ParsedLine[];
  /** Bytes after the last newline: an unacknowledged, torn write. */
  tornTail: number;
  /** Line numbers (1-based) of bad lines recovered by a following torn marker. */
  recoveredTorn: Set<number>;
  endsWithNewline: boolean;
}

export const TORN_MARKER = "torn-marker";

/**
 * Parse a JSONL file of envelopes. A run of bad lines immediately followed by
 * a torn marker is a recovered torn write; any other bad line is corruption.
 */
export function parseLines(text: string): ParsedFile {
  const parts = text.split("\n");
  const endsWithNewline = text.length === 0 || text.endsWith("\n");
  const tail = parts.pop() ?? "";
  const lines: ParsedLine[] = parts.map((raw, i) => {
    const line = i + 1;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      return { ok: false, line, problem: "unparseable" };
    }
    if (!v || typeof v !== "object" || Array.isArray(v))
      return { ok: false, line, problem: "malformed" };
    const env = v as Record<string, unknown>;
    if (typeof env.kind !== "string" || typeof env.sha256 !== "string" || !("body" in env)) {
      return { ok: false, line, problem: "malformed" };
    }
    let digest: string;
    try {
      digest = sha256Hex(canonicalJson({ body: env.body, kind: env.kind }));
    } catch {
      return { ok: false, line, problem: "malformed" };
    }
    if (digest !== env.sha256) return { ok: false, line, problem: "digest-mismatch" };
    return { ok: true, line, kind: env.kind, body: env.body, digest };
  });
  const recoveredTorn = new Set<number>();
  let run: number[] = [];
  for (const l of lines) {
    if (!l.ok) {
      // A digest mismatch parsed as JSON: that is damage, not a torn write.
      if (l.problem === "digest-mismatch") run = [];
      else run.push(l.line);
      continue;
    }
    if (l.kind === TORN_MARKER) for (const n of run) recoveredTorn.add(n);
    run = [];
  }
  return {
    lines,
    tornTail: Buffer.byteLength(tail, "utf8"),
    recoveredTorn,
    endsWithNewline,
  };
}

// ── Durable writes ──────────────────────────────────────────────────────────

/**
 * Closes a torn fragment. A NUL cannot end valid JSON, so a fragment that
 * happens to be a complete record minus its newline can never later parse
 * as an acknowledged record.
 */
export const TORN_FENCE = "\u0000\n";

/**
 * The prefix an append must write first when `file` ends in a torn write:
 * the fence (which also starts the next record on a fresh line), and a
 * torn marker, so readers can tell that fragment from interior damage.
 * Empty when the file ends cleanly (or does not exist).
 */
export async function tornPrefix(file: string, markerAt: string): Promise<string> {
  let fh;
  try {
    fh = await open(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return "";
    const window = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(window);
    await fh.read(buf, 0, window, size - window);
    if (buf[window - 1] === 0x0a) return "";
    const nl = buf.lastIndexOf(0x0a);
    // Bytes of the fragment back to the previous newline (a floor past 1 MiB).
    const fragmentBytes = nl === -1 ? window : window - nl - 1;
    return `${TORN_FENCE}${encodeLine(TORN_MARKER, { fragmentBytes, at: markerAt }).text}`;
  } finally {
    await fh.close();
  }
}

/** Append `prefix` and lines in one write, then fsync. Returns bytes written. */
export async function appendLines(
  file: string,
  prefix: string,
  lines: string[],
  write: WriteFn = defaultWrite,
): Promise<number> {
  await mkdir(path.dirname(file), { recursive: true });
  const fh = await open(file, "a");
  try {
    const data = Buffer.from(prefix + lines.join(""), "utf8");
    await writeAll(fh, data, write);
    await fh.sync();
    return data.length;
  } finally {
    await fh.close();
  }
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
