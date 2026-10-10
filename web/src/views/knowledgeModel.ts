import type {
  AtlasClaim,
  ClaimKind,
  EvidenceSource,
  KnowledgeAtlas,
  KnowledgeScope,
} from "@argus/contracts";
import type { TermId } from "./knowledgeGlossary";

/**
 * Presentation logic for the Knowledge view: grouping, naming, flagging.
 * Pure, so the view stays a thin renderer and every rule here is testable.
 */

/** Most common and most consequential first. */
export const KIND_ORDER: ClaimKind[] = [
  "business-rule",
  "constraint",
  "fact",
  "assumption",
  "conclusion",
  "decision",
];

/** Kind is shape, not colour: the status colours stay reserved for exceptions. */
export const KIND_GLYPH: Record<ClaimKind, string> = {
  "business-rule": "◆",
  constraint: "■",
  fact: "●",
  assumption: "○",
  conclusion: "▲",
  decision: "★",
};

const MODULE_RE = /^\s*\[([^\]\n]{1,80})\]\s*/;

/** Discovery prefixes a statement with the module it read: `[Commerce] …`. */
export function moduleOf(statement: string): string | null {
  return MODULE_RE.exec(statement)?.[1].trim() || null;
}

export function stripModule(statement: string): string {
  return statement.replace(MODULE_RE, "");
}

/** `RULE-1e8f9f4e.2a88aaca` → `RULE-1e8f`. The scope suffix and most of the
 *  hash say nothing to a reader; the full id stays one click away. */
export function shortId(id: string): string {
  const local = id.replace(/\.[0-9a-f]{8}$/, "");
  const hashed = /^([A-Z][A-Z-]*?)-([0-9a-f]{8,})$/.exec(local);
  return hashed ? `${hashed[1]}-${hashed[2].slice(0, 4)}` : local;
}

export function refKey(c: { id: string; revision: number }): string {
  return `${c.id}:v${c.revision}`;
}

export function scopeKey(scope: KnowledgeScope | null): string {
  return scope ? `${scope.projectId}/${scope.repositoryId}` : "";
}

/** `git:dev.azure.com/org/proj/_git/repo` → `repo`, with the project for context. */
export function scopeLabel(scope: KnowledgeScope | null): string {
  if (!scope) return "Unscoped";
  const repo = scope.repositoryId.split("/").filter(Boolean).pop() ?? scope.repositoryId;
  return repo === scope.projectId ? repo : `${scope.projectId} · ${repo}`;
}

export function atlasPath(scope: KnowledgeScope | null): string {
  if (!scope) return "/api/knowledge/atlas";
  const q = new URLSearchParams({ project: scope.projectId, repository: scope.repositoryId });
  return `/api/knowledge/atlas?${q.toString()}`;
}

export type ExceptionTone = "fail" | "run" | "idle";

export interface ClaimException {
  term: TermId;
  tone: ExceptionTone;
}

/** Every condition a row can be flagged for, and the colour it is flagged in. */
export const FLAGGED: Partial<Record<TermId, ExceptionTone>> = {
  contested: "fail",
  violated: "fail",
  stale: "run",
  unsupported: "run",
  superseded: "idle",
};

const flag = (term: TermId): ClaimException => ({ term, tone: FLAGGED[term]! });

/**
 * The one thing worth flagging on a row, or null when the claim is normal.
 * Normal says nothing: an active, supported claim gets no badge at all, so the
 * page only lights up where a reader should look.
 */
export function exceptionOf(c: AtlasClaim): ClaimException | null {
  if (c.support === "contested") return flag("contested");
  if (c.conformance === "violated") return flag("violated");
  if (c.stale) return flag("stale");
  if (c.lifecycle === "superseded") return flag("superseded");
  if (c.support === "unsupported") return flag("unsupported");
  return null;
}

/** The current wording of every claim. Superseded revisions are history, shown
 *  in the drawer, never as rows of their own. */
export function activeClaims(atlas: KnowledgeAtlas): AtlasClaim[] {
  return atlas.claims.filter((c) => c.lifecycle === "active");
}

export function revisionsOf(atlas: KnowledgeAtlas, id: string): AtlasClaim[] {
  return atlas.claims.filter((c) => c.id === id).sort((a, b) => a.revision - b.revision);
}

export function kindCounts(claims: AtlasClaim[]): Array<{ kind: ClaimKind; count: number }> {
  return KIND_ORDER.map((kind) => ({
    kind,
    count: claims.filter((c) => c.kind === kind).length,
  })).filter((k) => k.count > 0);
}

export interface AtlasSummary {
  claims: number;
  rules: number;
  supported: number;
  /** Rules with any recorded verification outcome. */
  verified: number;
  exceptions: number;
  superseded: number;
}

export function summarize(atlas: KnowledgeAtlas): AtlasSummary {
  const active = activeClaims(atlas);
  const rules = active.filter((c) => c.kind === "business-rule");
  return {
    claims: active.length,
    rules: rules.length,
    supported: active.filter((c) => c.support === "supported").length,
    verified: rules.filter((c) => c.conformance !== null && c.conformance !== "unverified").length,
    exceptions: active.filter((c) => exceptionOf(c) !== null).length,
    superseded: atlas.claims.length - active.length,
  };
}

export type GroupBy = "module" | "file";

export interface ClaimGroup {
  key: string;
  label: string;
  /** Muted context under the label (the directory, for a file group). */
  detail?: string;
  claims: AtlasClaim[];
  exceptions: number;
  /** The files most cited by this group's evidence, most cited first. */
  topFiles: string[];
}

const OTHER = "\u0000other";
const UNSCOPED = "\u0000unscoped";
const NO_CODE = "\u0000no-code";

export function codePaths(c: AtlasClaim): string[] {
  const paths = c.evidence.flatMap((e) => (e.source.type === "source-code" ? [e.source.path] : []));
  return [...new Set(paths)];
}

function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { name: path, dir: "" } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/**
 * Shelves for the overview. By module, each claim sits on exactly one shelf
 * (unscoped claims on their own, since nobody owns them). By file, a claim
 * appears under every file its evidence cites. Largest shelf first, the
 * catch-all shelves last.
 */
export function groupClaims(claims: AtlasClaim[], by: GroupBy): ClaimGroup[] {
  const groups = new Map<string, ClaimGroup>();
  const add = (key: string, label: string, claim: AtlasClaim, detail?: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { key, label, claims: [], exceptions: 0, topFiles: [], ...(detail ? { detail } : {}) };
      groups.set(key, g);
    }
    g.claims.push(claim);
    if (exceptionOf(claim)) g.exceptions += 1;
  };

  for (const c of claims) {
    if (by === "module") {
      if (!c.scope) add(UNSCOPED, "Unscoped", c);
      else {
        const mod = moduleOf(c.statement);
        add(mod ?? OTHER, mod ?? "Other", c);
      }
      continue;
    }
    const paths = codePaths(c);
    if (paths.length === 0) add(NO_CODE, "No code reference", c);
    for (const p of paths) {
      const { name, dir } = splitPath(p);
      add(p, name, c, dir || undefined);
    }
  }

  for (const g of groups.values()) g.topFiles = topFiles(g.claims, 2);
  const tail = (k: string) => Number(k.startsWith("\u0000"));
  return [...groups.values()].sort(
    (a, b) =>
      tail(a.key) - tail(b.key) ||
      b.claims.length - a.claims.length ||
      a.label.localeCompare(b.label),
  );
}

function topFiles(claims: AtlasClaim[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const c of claims) for (const p of codePaths(c)) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([p]) => splitPath(p).name);
}

export interface ClaimFilter {
  query: string;
  kind: ClaimKind | null;
  exceptionsOnly: boolean;
}

export const NO_FILTER: ClaimFilter = { query: "", kind: null, exceptionsOnly: false };

export function filterClaims(claims: AtlasClaim[], f: ClaimFilter): AtlasClaim[] {
  const q = f.query.trim().toLowerCase();
  return claims.filter(
    (c) =>
      (!f.kind || c.kind === f.kind) &&
      (!f.exceptionsOnly || exceptionOf(c) !== null) &&
      (!q ||
        c.statement.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        codePaths(c).some((p) => p.toLowerCase().includes(q))),
  );
}

/** `path:4-9@09ce3741 · Symbol`, or the human-readable form of other sources. */
export function describeSource(s: EvidenceSource): string {
  switch (s.type) {
    case "source-code": {
      const start = s.startLine ?? s.line;
      const lines =
        start === undefined
          ? ""
          : s.endLine && s.endLine !== start
            ? `:${start}-${s.endLine}`
            : `:${start}`;
      const head = s.gitHead ? `@${s.gitHead.slice(0, 8)}` : "";
      return `${s.path}${lines}${head}${s.symbol ? ` · ${s.symbol}` : ""}`;
    }
    case "run":
      return `run ${s.runId}`;
    case "phase":
      return `phase ${s.instanceId}/${s.phaseId}`;
    case "artifact":
      return `artifact ${s.path} (${s.instanceId}/${s.phaseId})`;
    case "verification":
      return `verification ${s.instanceId}/${s.phaseId}`;
    case "git-commit":
      return `commit ${s.sha.slice(0, 8)}${s.repository ? ` in ${s.repository}` : ""}`;
    case "document":
      return s.title ? `${s.title} (${s.uri})` : s.uri;
    case "human":
      return `stated by ${s.who}`;
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
