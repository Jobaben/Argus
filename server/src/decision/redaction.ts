import type { SnapshotRedaction, SnapshotTruncation } from "@argus/contracts";

/**
 * Deterministic, versioned redaction and truncation for snapshot bodies
 * (RFC §G.4, §O.4).
 *
 * Redaction runs **before** truncation, over the whole source text, so a cap
 * can never cut a secret in half and leave the prefix unmatched. Each rule is
 * a pure regular expression with a fixed replacement `[REDACTED:<rule id>]`;
 * no rule reads the environment, the clock or any live state, so the same
 * source always redacts to the same bytes. Rules are named `id@version` and
 * the list a projection applies is part of its (digested) definition.
 *
 * **Limits, stated plainly.** Pattern redaction is best effort: it removes
 * the credential shapes below, not every secret a transcript could carry. And
 * some sources arrive already clipped (the Recorder caps labels and details),
 * so a secret split by *that* clip before it reaches us may escape a pattern
 * with a minimum length. Projections therefore also keep their inputs narrow:
 * no raw transcript, no file contents, no environment.
 */

export interface RedactionRule {
  /** `id@version`. */
  id: string;
  pattern: RegExp;
  /** Replacement for one match; default replaces the whole match. */
  replace?: (match: string, ...groups: string[]) => string;
}

const mark = (id: string) => `[REDACTED:${id}]`;

export const REDACTION_RULES_V1: readonly RedactionRule[] = [
  {
    id: "secret.private-key@1",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { id: "secret.anthropic-key@1", pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { id: "secret.openai-key@1", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  {
    id: "secret.github-token@1",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  { id: "secret.aws-access-key@1", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "secret.slack-token@1", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  {
    id: "secret.bearer@1",
    pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (_m, word: string) => `${word} ${mark("secret.bearer@1")}`,
  },
  {
    id: "secret.url-credentials@1",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replace: (_m, scheme: string) => `${scheme}${mark("secret.url-credentials@1")}@`,
  },
  {
    // NAME=value / NAME: value where the name says it is a secret. The name is
    // kept (it is useful context); the value is not.
    id: "secret.assignment@1",
    pattern:
      /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi,
    replace: (_m, name: string, sep: string) => `${name}${sep}${mark("secret.assignment@1")}`,
  },
];

/** Code-point-safe length and prefix: a cap never splits a surrogate pair. */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function prefixCodePoints(s: string, max: number): string {
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n >= max) break;
    out += ch;
    n++;
  }
  return out;
}

/**
 * Accumulates the redactions and truncations applied while one body is
 * shaped, so the snapshot records exactly what was done to it.
 */
export class BodyShaper {
  private counts = new Map<string, number>();
  private cuts: SnapshotTruncation[] = [];

  constructor(private readonly rules: readonly RedactionRule[]) {}

  redact(text: string): string {
    let out = text;
    for (const rule of this.rules) {
      let n = 0;
      out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
        n++;
        // `replace` passes groups, then offset, then the whole string.
        const groups = rest.slice(0, -2).map((g) => (typeof g === "string" ? g : ""));
        return rule.replace ? rule.replace(match, ...groups) : mark(rule.id);
      });
      if (n > 0) this.counts.set(rule.id, (this.counts.get(rule.id) ?? 0) + n);
    }
    return out;
  }

  /** Redact, then keep at most `cap` code points, recording any cut at `pointer`. */
  text(pointer: string, value: string, cap: number): string {
    const redacted = this.redact(value);
    const total = codePoints(redacted);
    if (total <= cap) return redacted;
    this.cuts.push({ pointer, originalCodePoints: total, keptCodePoints: cap });
    return prefixCodePoints(redacted, cap);
  }

  redactions(): SnapshotRedaction[] {
    return [...this.counts.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  }

  truncations(): SnapshotTruncation[] {
    return [...this.cuts].sort((a, b) =>
      a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0,
    );
  }
}
