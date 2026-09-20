import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { mintHookToken, validateTrigger } from "./schedules.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import type { Dependency, PhaseDef, PhaseStep, PipelineDefinition } from "./pipelineTypes.js";
import type {
  CandidatePolicy,
  CandidateVariant,
  CapabilityProfile,
  ContextLimits,
  EnvPolicy,
  McpServerSpec,
  MemoryPolicy,
  PhaseCheck,
  RetryableClass,
  KnowledgeScopePolicy,
  WorkspacePolicy,
} from "./pipelineTypes.js";
import type { Trigger } from "./scheduleTypes.js";
import { RubricValidationError, validateAutoApprove, validateRubric } from "./verdict.js";
import { DagValidationError, validateDag } from "./dag.js";
import {
  RouteAuthoringError,
  validateDependency,
  validatePhaseResult,
  validateRoutes,
} from "./routeAuthoring.js";
import { isRuntimeId, runtimeIdList } from "../runtimes/index.js";
import {
  ARGUS_PER_INVOCATION_IDENTIFIERS,
  ARGUS_SERVER_SECRETS,
  matchesEnvPattern,
} from "../harness/childEnv.js";
import type {
  AcceptanceVerificationPolicy,
  AgentRuntimeId,
  ClaimKind,
  DiscoveryPolicy,
  ImplementationPolicy,
  DiscoveryScope,
  KnowledgeContextSpec,
  ChangeContextSpec,
  ChangeIntentPolicy,
  ReasoningEffort,
  RuleVerificationPolicy,
} from "@argus/contracts";
import { KnowledgeContextError, parseKnowledgeContextSpec } from "../knowledge/context.js";
import { KnowledgeValidationError } from "../knowledge/errors.js";
import { parseKnowledgeScopePolicy } from "../knowledge/scope.js";
import {
  DISCOVERY_LABEL_MAX_CHARS,
  DISCOVERY_NOTE_MAX_CHARS,
  DISCOVERY_SCOPE_MAX_PATHS,
} from "../knowledge/discovery.js";
import { CLAIM_KINDS, REALIZATION_MAX_ATTEMPTS, validArtifactPath } from "../knowledge/kernel.js";
import { ChangeProposalError, validateChangeRequest } from "../knowledge/changeIntent.js";
import { resolveNeeds } from "./dag.js";

// The crash-safe, mutex-serialized single-file store (shared with schedules).
const store = createJsonArrayStore<PipelineDefinition>({
  file: paths.pipelinesFile,
  label: "pipelines.json",
});
const withStoreLock = store.withLock;

export class PipelineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineValidationError";
  }
}

export interface PipelineInput {
  name: string;
  phases: PhaseDef[];
  trigger: Trigger | null;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
  model?: string;
  reasoningEffort?: ReasoningEffort;
  runtime?: AgentRuntimeId;
  capabilities?: CapabilityProfile;
  workspace?: WorkspacePolicy;
  knowledgeScope?: KnowledgeScopePolicy;
  contextLimits?: ContextLimits;
  memory?: MemoryPolicy;
}

// Model names are passed as a `--model <value>` argv pair to the agent CLI.
// Reject anything that could be mistaken for a flag (leading dash) or smuggle
// shell metacharacters on the win32 shell:true path — only plain identifier
// chars, plus the `/` that OpenCode's `<provider>/<model>` addressing requires.
// A slash is neither a shell metacharacter nor a flag introducer, and the first
// character still has to be alphanumeric.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PHASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REASONING_EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);

function validateReasoningEffort(raw: unknown, ctx: string): ReasoningEffort {
  if (!REASONING_EFFORTS.has(raw as ReasoningEffort)) {
    throw new PipelineValidationError(
      `${ctx}: reasoningEffort must be ${[...REASONING_EFFORTS].join(" | ")}`,
    );
  }
  return raw as ReasoningEffort;
}

/** A runtime override on a pipeline, phase or step. Undefined/null = inherit. */
function validateRuntime(raw: unknown, ctx: string): AgentRuntimeId | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRuntimeId(raw)) {
    throw new PipelineValidationError(`${ctx}: runtime must be ${runtimeIdList()}`);
  }
  return raw;
}

function validateModel(raw: unknown, ctx: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new PipelineValidationError(`${ctx}: model must be a non-empty string`);
  }
  const model = raw.trim();
  if (!MODEL_RE.test(model)) {
    throw new PipelineValidationError(`${ctx}: model "${model}" is not a valid model identifier`);
  }
  return model;
}

/** A wall-clock limit on a step's or phase's process. Undefined/null = no limit. */
function validateTimeout(raw: unknown, ctx: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 86400) {
    throw new PipelineValidationError(`${ctx}: timeoutSeconds must be an integer 1-86400`);
  }
  return n;
}

/** Kill a still-alive step whose transcript has gone quiet this long.
 *  Undefined/null = off. Minimum 30 — anything shorter is indistinguishable
 *  from ordinary gaps between tool calls and would fire on healthy runs. */
function validateStallSeconds(raw: unknown, ctx: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 30 || n > 86400) {
    throw new PipelineValidationError(`${ctx}: stallSeconds must be an integer 30-86400`);
  }
  return n;
}

/**
 * An isolation policy on a pipeline or a phase. Undefined/null = no isolation:
 * the phase runs in its own `cwd`, exactly as before workspaces existed.
 *
 * `base` becomes an argument to `git rev-parse` and `git worktree add`, so it
 * is held to what a ref can be here rather than at the point of use: no
 * whitespace (one argument, not several) and no leading `-` (a ref, never a
 * flag). Whether the ref *exists* is git's answer, at the moment the phase
 * starts — a branch a pipeline is authored against may be created later.
 */
export function validateWorkspace(raw: unknown, ctx: string): WorkspacePolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: workspace must be an object`);
  }
  const w = raw as Record<string, unknown>;
  for (const key of Object.keys(w)) {
    if (!WORKSPACE_KEYS.has(key)) {
      throw new PipelineValidationError(`${ctx}: workspace has unknown key "${key}"`);
    }
  }
  if (!WORKSPACE_SCOPES.has(w.scope as WorkspacePolicy["scope"])) {
    throw new PipelineValidationError(
      `${ctx}: workspace.scope must be ${[...WORKSPACE_SCOPES].join(" | ")}`,
    );
  }
  const policy: WorkspacePolicy = { scope: w.scope as WorkspacePolicy["scope"] };
  if (w.base !== undefined && w.base !== null) {
    if (typeof w.base !== "string" || !w.base.trim()) {
      throw new PipelineValidationError(`${ctx}: workspace.base must be a non-empty string`);
    }
    const base = w.base.trim();
    if (/\s/.test(base) || base.startsWith("-")) {
      throw new PipelineValidationError(
        `${ctx}: workspace.base "${base}" is not a valid git ref (no whitespace, no leading "-")`,
      );
    }
    policy.base = base;
  }
  if (w.keep !== undefined && w.keep !== null) {
    if (typeof w.keep !== "boolean") {
      throw new PipelineValidationError(`${ctx}: workspace.keep must be a boolean`);
    }
    policy.keep = w.keep;
  }
  return policy;
}

const WORKSPACE_KEYS = new Set(["scope", "base", "keep"]);
const WORKSPACE_SCOPES = new Set<WorkspacePolicy["scope"]>(["instance", "attempt", "none"]);

// ── Candidates ───────────────────────────────────────────────────────────────

const CANDIDATE_KEYS = new Set(["count", "select", "variants"]);
const CANDIDATE_VARIANT_KEYS = new Set(["runtime", "model", "reasoningEffort"]);
const CANDIDATE_SELECTORS = new Set<CandidatePolicy["select"]>([
  "first-verified",
  "cheapest-verified",
]);
export const MIN_CANDIDATES = 2;
export const MAX_CANDIDATES = 8;

function validateCandidateVariant(raw: unknown, ctx: string, i: number): CandidateVariant {
  const where = `${ctx}: candidates.variants[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${where} must be an object`);
  }
  const v = raw as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!CANDIDATE_VARIANT_KEYS.has(key)) {
      throw new PipelineValidationError(`${where} has unknown key "${key}"`);
    }
  }
  // Each field is held to exactly what the step field it overrides is held to:
  // a variant is a step override that happens to be written somewhere else.
  const variant: CandidateVariant = {};
  const runtime = validateRuntime(v.runtime, where);
  if (runtime) variant.runtime = runtime;
  if (v.model !== undefined && v.model !== null) variant.model = validateModel(v.model, where);
  if (v.reasoningEffort !== undefined && v.reasoningEffort !== null) {
    variant.reasoningEffort = validateReasoningEffort(v.reasoningEffort, where);
  }
  return variant;
}

/**
 * Best-of-N on one phase.
 *
 * The shape is checked here; the two *structural* requirements — exactly one
 * step, and attempt-scoped isolation — are checked by the caller, because the
 * second of them can only be answered once the pipeline's own policy is known
 * ({@link assertCandidatesRunnable}).
 */
export function validateCandidates(raw: unknown, ctx: string): CandidatePolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: candidates must be an object`);
  }
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!CANDIDATE_KEYS.has(key)) {
      throw new PipelineValidationError(`${ctx}: candidates has unknown key "${key}"`);
    }
  }
  const count = Number(c.count);
  if (!Number.isInteger(count) || count < MIN_CANDIDATES || count > MAX_CANDIDATES) {
    throw new PipelineValidationError(
      `${ctx}: candidates.count must be an integer ${MIN_CANDIDATES}-${MAX_CANDIDATES}`,
    );
  }
  if (!CANDIDATE_SELECTORS.has(c.select as CandidatePolicy["select"])) {
    throw new PipelineValidationError(
      `${ctx}: candidates.select must be ${[...CANDIDATE_SELECTORS].join(" | ")}`,
    );
  }
  const policy: CandidatePolicy = { count, select: c.select as CandidatePolicy["select"] };
  if (c.variants !== undefined && c.variants !== null) {
    if (!Array.isArray(c.variants)) {
      throw new PipelineValidationError(`${ctx}: candidates.variants must be a list`);
    }
    if (c.variants.length > MAX_CANDIDATES) {
      throw new PipelineValidationError(
        `${ctx}: candidates.variants is capped at ${MAX_CANDIDATES} entries`,
      );
    }
    policy.variants = c.variants.map((v, i) => validateCandidateVariant(v, ctx, i));
  }
  return policy;
}

/**
 * The two things a `candidates` phase needs that its own object cannot say.
 *
 * One step, because selection replaces a phase's result with one candidate's
 * and there is no defined answer for "which of three steps did candidate 2
 * win with". Attempt-scoped isolation, because without a worktree per
 * candidate the candidates are not independent samples of the same task — they
 * are N agents editing one checkout.
 *
 * Separated from {@link validateCandidates} because the isolation in force is
 * `phase.workspace ?? pipeline.workspace`, and a phase alone cannot see the
 * second half of that.
 */
export function assertCandidatesRunnable(
  phases: PhaseDef[],
  pipelineWorkspace: WorkspacePolicy | undefined,
): void {
  phases.forEach((phase, i) => {
    if (!phase.candidates) return;
    if (phase.steps.length !== 1) {
      throw new PipelineValidationError(
        `phase ${i}: candidates requires exactly one step (this phase has ${phase.steps.length}) — ` +
          "a selection replaces the phase's whole result with one candidate's",
      );
    }
    const scope = (phase.workspace ?? pipelineWorkspace)?.scope;
    if (scope !== "attempt") {
      throw new PipelineValidationError(
        `phase ${i}: candidates requires workspace.scope "attempt" on the phase or the pipeline ` +
          `(effective isolation: ${scope ? `"${scope}"` : "none"}) — without a worktree per ` +
          "candidate they would all be editing the same checkout",
      );
    }
  });
}

// ── Context and memory ───────────────────────────────────────────────────────

const CONTEXT_LIMITS_KEYS = new Set(["placeholderBytes"]);
const MIN_PLACEHOLDER_BYTES = 1024;
const MAX_PLACEHOLDER_BYTES = 262_144;

/** Per-placeholder byte cap on interpolated prompt text. Undefined/null =
 *  every placeholder uses the 16 KiB default (`DEFAULT_PLACEHOLDER_BYTES`). */
export function validateContextLimits(raw: unknown, ctx: string): ContextLimits | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: contextLimits must be an object`);
  }
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!CONTEXT_LIMITS_KEYS.has(key)) {
      throw new PipelineValidationError(`${ctx}: contextLimits has unknown key "${key}"`);
    }
  }
  if (c.placeholderBytes === undefined || c.placeholderBytes === null) return {};
  const n = Number(c.placeholderBytes);
  if (!Number.isInteger(n) || n < MIN_PLACEHOLDER_BYTES || n > MAX_PLACEHOLDER_BYTES) {
    throw new PipelineValidationError(
      `${ctx}: contextLimits.placeholderBytes must be an integer ${MIN_PLACEHOLDER_BYTES}-${MAX_PLACEHOLDER_BYTES}`,
    );
  }
  return { placeholderBytes: n };
}

const MEMORY_KEYS = new Set(["enabled", "maxBytes"]);
const MIN_MEMORY_BYTES = 1024;
const MAX_MEMORY_BYTES = 65_536;

/**
 * Durable, cross-instance notes for a pipeline (`NOTES.md`). Undefined/null =
 * off — `{{memory}}` interpolates to empty and no `ARGUS_MEMORY_DIR` is set.
 */
export function validateMemory(raw: unknown, ctx: string): MemoryPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: memory must be an object`);
  }
  const m = raw as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!MEMORY_KEYS.has(key)) {
      throw new PipelineValidationError(`${ctx}: memory has unknown key "${key}"`);
    }
  }
  if (typeof m.enabled !== "boolean") {
    throw new PipelineValidationError(`${ctx}: memory.enabled must be a boolean`);
  }
  const policy: MemoryPolicy = { enabled: m.enabled };
  if (m.maxBytes !== undefined && m.maxBytes !== null) {
    const n = Number(m.maxBytes);
    if (!Number.isInteger(n) || n < MIN_MEMORY_BYTES || n > MAX_MEMORY_BYTES) {
      throw new PipelineValidationError(
        `${ctx}: memory.maxBytes must be an integer ${MIN_MEMORY_BYTES}-${MAX_MEMORY_BYTES}`,
      );
    }
    policy.maxBytes = n;
  }
  return policy;
}

// ── Capability profiles ──────────────────────────────────────────────────────

const CAPABILITY_KEYS = new Set([
  "filesystem",
  "tools",
  "mcpServers",
  "additionalDirectories",
  "settingSources",
  "permissionMode",
  "maxTurns",
  "env",
  "enforcement",
]);
const FILESYSTEM_MODES = new Set(["read-only", "workspace-write", "unrestricted"]);
const SETTING_SOURCES = new Set(["user", "project", "local"]);
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);
const ENV_INHERIT = new Set(["all", "minimal"]);
const MCP_TYPES = new Set(["stdio", "http", "sse"]);
const ENFORCEMENT_MODES = new Set(["strict", "best-effort"]);
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// A variable name, optionally with one trailing `*` wildcard (matched via
// `matchesEnvPattern`, shared with the harness's own env-policy engine).
const ENV_PATTERN_RE = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;
const ENV_SET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TOOL_RULES = 200;

// Names Argus reserves for the harness's own control-plane use (see
// `../harness/childEnv.ts`) — `env.set` may never overwrite these, since that
// would let a pipeline author hand an agent process its own admin token or
// forge another invocation's identifiers.
const RESERVED_ENV_PATTERNS: readonly string[] = [
  ...ARGUS_SERVER_SECRETS,
  ...ARGUS_PER_INVOCATION_IDENTIFIERS,
];

function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV_PATTERNS.some((pattern) => matchesEnvPattern(name, pattern));
}

/** Keys of an MCP server's `env`/`headers`: plain identifiers (and `-` for
 *  header names), because Codex receives them unquoted inside `-c` overrides. */
const RECORD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function validateStringRecord(raw: unknown, ctx: string): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx} must be an object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!RECORD_KEY_RE.test(key)) {
      throw new PipelineValidationError(`${ctx} has an invalid key "${key}"`);
    }
    if (typeof value !== "string") {
      throw new PipelineValidationError(`${ctx}.${key} must be a string`);
    }
    out[key] = value;
  }
  return out;
}

function validateToolRules(raw: unknown, ctx: string): string[] {
  if (!Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx} must be a list of strings`);
  }
  if (raw.length > MAX_TOOL_RULES) {
    throw new PipelineValidationError(`${ctx} is capped at ${MAX_TOOL_RULES} rules`);
  }
  const rules: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new PipelineValidationError(`${ctx} entries must be non-empty strings`);
    }
    // Rules are joined comma-separated on the CLI, so a comma (or a newline,
    // which would also corrupt the joined line) inside one rule is ambiguous.
    if (entry.includes(",") || entry.includes("\n")) {
      throw new PipelineValidationError(`${ctx}: tool rule "${entry}" must not contain a comma`);
    }
    rules.push(entry);
  }
  return [...new Set(rules)];
}

function validateMcpServer(raw: unknown, name: string, ctx: string): McpServerSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: mcpServers["${name}"] must be an object`);
  }
  const s = raw as Record<string, unknown>;
  const server: McpServerSpec = {};

  if (s.type !== undefined && s.type !== null) {
    if (!MCP_TYPES.has(s.type as string)) {
      throw new PipelineValidationError(
        `${ctx}: mcpServers["${name}"].type must be ${[...MCP_TYPES].join(" | ")}`,
      );
    }
    server.type = s.type as McpServerSpec["type"];
  }
  if (s.command !== undefined && s.command !== null) {
    const command = s.command;
    if (typeof command !== "string" || !command.trim()) {
      throw new PipelineValidationError(
        `${ctx}: mcpServers["${name}"].command must be a non-empty string`,
      );
    }
    server.command = command;
  }
  if (s.args !== undefined && s.args !== null) {
    const args = s.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new PipelineValidationError(
        `${ctx}: mcpServers["${name}"].args must be a list of strings`,
      );
    }
    server.args = [...args] as string[];
  }
  if (s.env !== undefined && s.env !== null) {
    server.env = validateStringRecord(s.env, `${ctx}: mcpServers["${name}"].env`);
  }
  if (s.url !== undefined && s.url !== null) {
    const url = s.url;
    if (typeof url !== "string" || !url.trim()) {
      throw new PipelineValidationError(
        `${ctx}: mcpServers["${name}"].url must be a non-empty string`,
      );
    }
    server.url = url;
  }
  if (s.headers !== undefined && s.headers !== null) {
    server.headers = validateStringRecord(s.headers, `${ctx}: mcpServers["${name}"].headers`);
  }
  if (!server.command && !server.url) {
    throw new PipelineValidationError(
      `${ctx}: mcpServers["${name}"] needs either command (stdio) or url (http/sse)`,
    );
  }
  return server;
}

function validateEnvPolicy(raw: unknown, ctx: string): EnvPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: capabilities.env must be an object`);
  }
  const e = raw as Record<string, unknown>;
  const env: EnvPolicy = {};

  if (e.inherit !== undefined && e.inherit !== null) {
    if (!ENV_INHERIT.has(e.inherit as string)) {
      throw new PipelineValidationError(
        `${ctx}: capabilities.env.inherit must be ${[...ENV_INHERIT].join(" | ")}`,
      );
    }
    env.inherit = e.inherit as EnvPolicy["inherit"];
  }

  for (const side of ["allow", "deny"] as const) {
    const raw2 = e[side];
    if (raw2 === undefined || raw2 === null) continue;
    if (!Array.isArray(raw2)) {
      throw new PipelineValidationError(
        `${ctx}: capabilities.env.${side} must be a list of strings`,
      );
    }
    const patterns: string[] = [];
    for (const entry of raw2) {
      if (typeof entry !== "string" || !ENV_PATTERN_RE.test(entry)) {
        throw new PipelineValidationError(
          `${ctx}: capabilities.env.${side} entries must be a variable name, optionally with one trailing *`,
        );
      }
      patterns.push(entry);
    }
    env[side] = [...new Set(patterns)];
  }

  if (e.set !== undefined && e.set !== null) {
    if (typeof e.set !== "object" || Array.isArray(e.set)) {
      throw new PipelineValidationError(`${ctx}: capabilities.env.set must be an object`);
    }
    const set: Record<string, string> = {};
    for (const [key, value] of Object.entries(e.set as Record<string, unknown>)) {
      if (!ENV_SET_KEY_RE.test(key)) {
        throw new PipelineValidationError(
          `${ctx}: env.set key "${key}" must be a valid environment variable name`,
        );
      }
      if (isReservedEnvName(key)) {
        throw new PipelineValidationError(
          `${ctx}: env.set must not set reserved variable "${key}"`,
        );
      }
      if (typeof value !== "string") {
        throw new PipelineValidationError(`${ctx}: env.set["${key}"] must be a string`);
      }
      set[key] = value;
    }
    env.set = set;
  }

  return env;
}

/**
 * What an agent invocation may do (see `CapabilityProfile` in
 * `@argus/contracts`). Undefined/null = inherit the pipeline's profile, or the
 * CLI's own defaults with no profile at all. Returns a fresh object containing
 * only the keys the author actually set, so a stored definition round-trips
 * byte for byte.
 */
export function validateCapabilities(raw: unknown, ctx: string): CapabilityProfile | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: capabilities must be an object`);
  }
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!CAPABILITY_KEYS.has(key)) {
      throw new PipelineValidationError(`${ctx}: capabilities has unknown key "${key}"`);
    }
  }

  const out: CapabilityProfile = {};

  if (c.filesystem !== undefined && c.filesystem !== null) {
    if (!FILESYSTEM_MODES.has(c.filesystem as string)) {
      throw new PipelineValidationError(
        `${ctx}: capabilities.filesystem must be ${[...FILESYSTEM_MODES].join(" | ")}`,
      );
    }
    out.filesystem = c.filesystem as CapabilityProfile["filesystem"];
  }

  if (c.tools !== undefined && c.tools !== null) {
    if (typeof c.tools !== "object" || Array.isArray(c.tools)) {
      throw new PipelineValidationError(`${ctx}: capabilities.tools must be an object`);
    }
    const t = c.tools as Record<string, unknown>;
    const tools: { allow?: string[]; deny?: string[] } = {};
    if (t.allow !== undefined && t.allow !== null) {
      tools.allow = validateToolRules(t.allow, `${ctx}: capabilities.tools.allow`);
    }
    if (t.deny !== undefined && t.deny !== null) {
      tools.deny = validateToolRules(t.deny, `${ctx}: capabilities.tools.deny`);
    }
    out.tools = tools;
  }

  if (c.mcpServers !== undefined && c.mcpServers !== null) {
    if (typeof c.mcpServers !== "object" || Array.isArray(c.mcpServers)) {
      throw new PipelineValidationError(`${ctx}: capabilities.mcpServers must be an object`);
    }
    const servers: Record<string, McpServerSpec> = {};
    for (const [name, spec] of Object.entries(c.mcpServers as Record<string, unknown>)) {
      if (!MCP_NAME_RE.test(name)) {
        throw new PipelineValidationError(
          `${ctx}: mcpServers key "${name}" must match ${MCP_NAME_RE}`,
        );
      }
      servers[name] = validateMcpServer(spec, name, ctx);
    }
    out.mcpServers = servers;
  }

  if (c.additionalDirectories !== undefined && c.additionalDirectories !== null) {
    if (!Array.isArray(c.additionalDirectories)) {
      throw new PipelineValidationError(
        `${ctx}: capabilities.additionalDirectories must be a list of paths`,
      );
    }
    out.additionalDirectories = c.additionalDirectories.map((d, i) => {
      if (
        typeof d !== "string" ||
        !d.trim() ||
        !path.isAbsolute(d) ||
        !existsSync(d) ||
        !statSync(d).isDirectory()
      ) {
        throw new PipelineValidationError(
          `${ctx}: additionalDirectories[${i}] does not exist: ${String(d)}`,
        );
      }
      return d;
    });
  }

  if (c.settingSources !== undefined && c.settingSources !== null) {
    if (
      !Array.isArray(c.settingSources) ||
      c.settingSources.some((s) => !SETTING_SOURCES.has(String(s)))
    ) {
      throw new PipelineValidationError(
        `${ctx}: capabilities.settingSources must be a list of ${[...SETTING_SOURCES].join(" | ")}`,
      );
    }
    out.settingSources = [
      ...new Set(c.settingSources.map(String)),
    ] as CapabilityProfile["settingSources"];
  }

  if (c.permissionMode !== undefined && c.permissionMode !== null) {
    if (!PERMISSION_MODES.has(c.permissionMode as string)) {
      throw new PipelineValidationError(
        `${ctx}: capabilities.permissionMode must be ${[...PERMISSION_MODES].join(" | ")}`,
      );
    }
    out.permissionMode = c.permissionMode as CapabilityProfile["permissionMode"];
  }

  if (c.maxTurns !== undefined && c.maxTurns !== null) {
    const n = Number(c.maxTurns);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      throw new PipelineValidationError(`${ctx}: capabilities.maxTurns must be an integer 1-1000`);
    }
    out.maxTurns = n;
  }

  if (c.env !== undefined && c.env !== null) {
    out.env = validateEnvPolicy(c.env, ctx);
  }

  if (c.enforcement !== undefined && c.enforcement !== null) {
    if (!ENFORCEMENT_MODES.has(c.enforcement as string)) {
      throw new PipelineValidationError(
        `${ctx}: capabilities.enforcement must be ${[...ENFORCEMENT_MODES].join(" | ")}`,
      );
    }
    out.enforcement = c.enforcement as CapabilityProfile["enforcement"];
  }

  return out;
}

// ── Verification checks ──────────────────────────────────────────────────────

const MAX_CHECKS = 50;
const CHECK_KINDS = new Set(["command", "artifact", "file", "changed-files"]);
const CHECK_BASE_KEYS = ["kind", "label"];
const CHECK_KIND_KEYS: Record<string, string[]> = {
  command: ["run", "cwd", "timeoutSeconds"],
  artifact: ["path", "minBytes"],
  file: ["path", "minBytes"],
  "changed-files": ["allow", "deny", "requireChanges"],
};

function validateCheckLabel(raw: unknown, ctx: string, i: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 120) {
    throw new PipelineValidationError(
      `${ctx}: checks[${i}].label must be a non-empty string up to 120 chars`,
    );
  }
  return raw;
}

/** A `checks[i].path`: relative, and unable to escape the directory it is read against. */
function validateCheckPath(raw: unknown, ctx: string, i: number): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new PipelineValidationError(`${ctx}: checks[${i}].path is required`);
  }
  const p = raw.trim();
  const segments = p.split(/[/\\]/);
  if (path.isAbsolute(p) || segments.some((seg) => seg === "..")) {
    throw new PipelineValidationError(
      `${ctx}: checks[${i}].path must be a relative path inside the directory`,
    );
  }
  return p;
}

function validateMinBytes(raw: unknown, ctx: string, i: number): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new PipelineValidationError(
      `${ctx}: checks[${i}].minBytes must be a non-negative integer`,
    );
  }
  return n;
}

function validateGlobList(
  raw: unknown,
  ctx: string,
  i: number,
  field: string,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((g) => typeof g !== "string" || !g.trim())) {
    throw new PipelineValidationError(
      `${ctx}: checks[${i}].${field} must be a list of non-empty globs`,
    );
  }
  return [...raw] as string[];
}

function validateCheck(raw: unknown, ctx: string, i: number): PhaseCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: checks[${i}] must be an object`);
  }
  const c = raw as Record<string, unknown>;
  const kind = c.kind;
  if (typeof kind !== "string" || !CHECK_KINDS.has(kind)) {
    throw new PipelineValidationError(
      `${ctx}: checks[${i}].kind must be ${[...CHECK_KINDS].join(" | ")}`,
    );
  }
  const allowedKeys = new Set([...CHECK_BASE_KEYS, ...CHECK_KIND_KEYS[kind]]);
  for (const key of Object.keys(c)) {
    if (!allowedKeys.has(key)) {
      throw new PipelineValidationError(`${ctx}: checks[${i}] has unknown key "${key}"`);
    }
  }
  const label = validateCheckLabel(c.label, ctx, i);

  if (kind === "command") {
    const run = c.run;
    if (typeof run !== "string" || !run.trim() || run.length > 4000) {
      throw new PipelineValidationError(
        `${ctx}: checks[${i}].run must be a non-empty string up to 4000 chars`,
      );
    }
    let cwd: string | undefined;
    if (c.cwd !== undefined && c.cwd !== null) {
      const rawCwd = c.cwd;
      if (typeof rawCwd !== "string" || !rawCwd.trim()) {
        throw new PipelineValidationError(`${ctx}: checks[${i}].cwd must be a non-empty string`);
      }
      cwd = rawCwd;
    }
    const timeoutSeconds = validateTimeout(c.timeoutSeconds, `${ctx}: checks[${i}]`);
    return {
      kind: "command",
      run,
      ...(label !== undefined ? { label } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    };
  }

  if (kind === "artifact" || kind === "file") {
    const checkPath = validateCheckPath(c.path, ctx, i);
    const minBytes = validateMinBytes(c.minBytes, ctx, i);
    return {
      kind,
      path: checkPath,
      ...(label !== undefined ? { label } : {}),
      ...(minBytes !== undefined ? { minBytes } : {}),
    };
  }

  // "changed-files"
  const allow = validateGlobList(c.allow, ctx, i, "allow");
  const deny = validateGlobList(c.deny, ctx, i, "deny");
  let requireChanges: boolean | undefined;
  if (c.requireChanges !== undefined && c.requireChanges !== null) {
    if (typeof c.requireChanges !== "boolean") {
      throw new PipelineValidationError(`${ctx}: checks[${i}].requireChanges must be a boolean`);
    }
    requireChanges = c.requireChanges;
  }
  return {
    kind: "changed-files",
    ...(label !== undefined ? { label } : {}),
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined ? { deny } : {}),
    ...(requireChanges !== undefined ? { requireChanges } : {}),
  };
}

/**
 * A phase's deterministic checks (see `PhaseCheck` in `@argus/contracts`).
 * Undefined/null = no checks — the legacy behaviour, where a phase's success
 * is exactly its steps' own reports.
 */
export function validateChecks(raw: unknown, ctx: string): PhaseCheck[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new PipelineValidationError(`${ctx}: checks must be a list`);
  if (raw.length > MAX_CHECKS) {
    throw new PipelineValidationError(`${ctx}: checks is capped at ${MAX_CHECKS}`);
  }
  return raw.map((r, i) => validateCheck(r, ctx, i));
}

function validateStep(raw: unknown, ctx: string): PhaseStep {
  if (!raw || typeof raw !== "object")
    throw new PipelineValidationError(`${ctx}: step must be an object`);
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== "string" || !s.name.trim())
    throw new PipelineValidationError(`${ctx}: step name is required`);
  if (typeof s.prompt !== "string" || !s.prompt.trim())
    throw new PipelineValidationError(`${ctx}: step prompt is required`);
  const step: PhaseStep = { name: s.name.trim(), prompt: s.prompt.trim() };
  if (s.model !== undefined && s.model !== null)
    step.model = validateModel(s.model, `${ctx}: step`);
  if (s.reasoningEffort !== undefined && s.reasoningEffort !== null) {
    step.reasoningEffort = validateReasoningEffort(s.reasoningEffort, `${ctx}: step`);
  }
  const runtime = validateRuntime(s.runtime, `${ctx}: step`);
  if (runtime) step.runtime = runtime;

  const stepCtx = `${ctx}: step "${step.name}"`;
  const timeoutSeconds = validateTimeout(s.timeoutSeconds, stepCtx);
  if (timeoutSeconds !== undefined) step.timeoutSeconds = timeoutSeconds;
  const stallSeconds = validateStallSeconds(s.stallSeconds, stepCtx);
  if (stallSeconds !== undefined) step.stallSeconds = stallSeconds;
  const capabilities = validateCapabilities(s.capabilities, stepCtx);
  if (capabilities) step.capabilities = capabilities;
  const knowledgeContext = validateKnowledgeContext(s.knowledgeContext, stepCtx);
  if (knowledgeContext) step.knowledgeContext = knowledgeContext;

  return step;
}

/**
 * The semantic context a step (or every step of a phase) receives — Phase 4
 * (`docs/KNOWLEDGE-LEDGER.md` § KnowledgeContext). Shape only: selectors are
 * well formed, each claim id appears once, strings are normalized to the
 * object form. Whether the claims *exist* is a question for the ledger at
 * launch, where a selector that cannot be resolved refuses the step as a
 * `configuration` failure — a claim a later phase will create may be named
 * by a definition saved before it exists.
 */
function validateKnowledgeContext(raw: unknown, ctx: string): KnowledgeContextSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    return parseKnowledgeContextSpec(raw);
  } catch (e) {
    if (e instanceof KnowledgeContextError)
      throw new PipelineValidationError(`${ctx}: ${e.message}`);
    throw e;
  }
}

/**
 * The knowledge scope a pipeline (or one phase of it) writes into — §
 * `docs/KNOWLEDGE-LEDGER.md` § KnowledgeScope. Shape only: the project id is
 * an identifier, a declared repository id is an identifier and never a
 * filesystem path, and `alsoRead` names fully-specified scopes. Whether the
 * repository identity can be *derived* is a question for the working tree at
 * launch, where a tree that answers neither a normalized remote nor a root
 * commit refuses the phase as a `configuration` failure.
 */
function validateKnowledgeScope(raw: unknown, ctx: string): KnowledgeScopePolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    return parseKnowledgeScopePolicy(raw);
  } catch (e) {
    if (e instanceof KnowledgeValidationError)
      throw new PipelineValidationError(`${ctx}: ${e.message}`);
    throw e;
  }
}

/**
 * Run a route/result check, re-badging its error as a pipeline validation error
 * so the route's existing 400 mapping covers it — the same wrapping the rubric
 * checks get, and for the same reason: an authoring mistake is a 400, not a 500.
 */
function routeChecked<T>(check: () => T): T {
  try {
    return check();
  } catch (e) {
    throw new PipelineValidationError(e instanceof RouteAuthoringError ? e.message : String(e));
  }
}

function validatePhase(raw: unknown, i: number): PhaseDef {
  if (!raw || typeof raw !== "object")
    throw new PipelineValidationError(`phase ${i} must be an object`);
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id.trim())
    throw new PipelineValidationError(`phase ${i}: id is required`);
  const id = p.id.trim();
  // The id names directories on disk (artifacts, baselines): one path segment,
  // no separators, never `.`/`..`.
  if (!PHASE_ID_RE.test(id)) {
    throw new PipelineValidationError(
      `phase ${i}: id must be 1-80 letters, digits, ".", "-" or "_" and start with a letter or digit`,
    );
  }
  if (typeof p.name !== "string" || !p.name.trim())
    throw new PipelineValidationError(`phase ${i}: name is required`);
  if (
    typeof p.cwd !== "string" ||
    !p.cwd.trim() ||
    !existsSync(p.cwd) ||
    !statSync(p.cwd).isDirectory()
  ) {
    throw new PipelineValidationError(`phase ${i}: cwd does not exist: ${String(p.cwd)}`);
  }
  if (!Array.isArray(p.steps) || p.steps.length === 0) {
    throw new PipelineValidationError(`phase ${i}: needs at least one step`);
  }
  const steps = p.steps.map((s) => validateStep(s, `phase ${i}`));
  const gated = Boolean(p.gated);

  // Rubric errors surface as pipeline validation errors so the route's existing
  // 400 mapping covers them instead of letting them escape as a 500.
  let rubric, autoApprove;
  try {
    rubric = validateRubric(p.rubric);
    autoApprove = validateAutoApprove(p.autoApprove, rubric !== undefined);
  } catch (e) {
    throw new PipelineValidationError(
      `phase ${i}: ${e instanceof RubricValidationError ? e.message : String(e)}`,
    );
  }
  if (autoApprove && !gated) {
    throw new PipelineValidationError(
      `phase ${i}: autoApprove only means something on a gated phase`,
    );
  }

  // Dependency edges. `needs: []` is meaningful (an explicit root), so the
  // key's *presence* is what switches the whole graph from linear-implicit to
  // explicit — see resolveNeeds. An entry is either the legacy phase id or a
  // route-carrying edge object; the string form is preserved as a string so a
  // pre-routing definition round-trips byte for byte.
  let needs: Dependency[] | undefined;
  if (p.needs !== undefined) {
    if (!Array.isArray(p.needs)) {
      throw new PipelineValidationError(`phase ${i}: needs must be a list of phase ids`);
    }
    needs = p.needs.map((n) => routeChecked(() => validateDependency(n, `phase "${id}"`)));
  }

  // The declared structured result. Validated against this phase's own steps
  // here; whether a *condition* can read it is a whole-graph question, checked
  // in validateRoutes once every phase's schema is known.
  const result =
    p.result === undefined || p.result === null
      ? undefined
      : routeChecked(() => validatePhaseResult(p.result, id, steps));

  const retry = validateRetry(p.retry, i);
  const runtime = validateRuntime(p.runtime, `phase ${i}`);

  let produces: string | undefined;
  if (p.produces !== undefined && p.produces !== null) {
    if (typeof p.produces !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(p.produces)) {
      throw new PipelineValidationError(
        `phase ${i}: produces must be a short name of letters, digits, - or _`,
      );
    }
    produces = p.produces;
  }

  const timeoutSeconds = validateTimeout(p.timeoutSeconds, `phase ${i}`);
  const stallSeconds = validateStallSeconds(p.stallSeconds, `phase ${i}`);
  const capabilities = validateCapabilities(p.capabilities, `phase ${i}`);
  const checks = validateChecks(p.checks, `phase ${i}`);
  const workspace = validateWorkspace(p.workspace, `phase ${i}`);
  const knowledgeScope = validateKnowledgeScope(p.knowledgeScope, `phase ${i}`);
  const candidates = validateCandidates(p.candidates, `phase ${i}`);
  const knowledgeDelta = validateKnowledgeDelta(p.knowledgeDelta, `phase ${i}`);
  const knowledgeContext = validateKnowledgeContext(p.knowledgeContext, `phase ${i}`);
  const discovery = validateDiscovery(p.discovery, `phase ${i}`);
  const ruleVerification = validateRuleVerification(p.ruleVerification, `phase ${i}`);
  const changeIntent = validateChangeIntent(p.changeIntent, `phase ${i}`, gated);
  const changeContext = validateChangeContext(p.changeContext, `phase ${i}`);
  const implementation = validateImplementation(p.implementation, `phase ${i}`, changeContext);
  const acceptanceVerification = validateAcceptanceVerification(
    p.acceptanceVerification,
    `phase ${i}`,
    changeContext,
  );

  return {
    id,
    name: p.name.trim(),
    cwd: p.cwd,
    steps,
    gated,
    ...(needs === undefined ? {} : { needs }),
    ...(result ? { result } : {}),
    ...(retry ? { retry } : {}),
    ...(produces ? { produces } : {}),
    ...(rubric ? { rubric } : {}),
    ...(autoApprove ? { autoApprove } : {}),
    ...(runtime ? { runtime } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(stallSeconds !== undefined ? { stallSeconds } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(checks ? { checks } : {}),
    ...(workspace ? { workspace } : {}),
    ...(knowledgeScope ? { knowledgeScope } : {}),
    ...(candidates ? { candidates } : {}),
    ...(knowledgeDelta ? { knowledgeDelta } : {}),
    ...(knowledgeContext ? { knowledgeContext } : {}),
    ...(discovery ? { discovery } : {}),
    ...(ruleVerification ? { ruleVerification } : {}),
    ...(changeIntent ? { changeIntent } : {}),
    ...(changeContext ? { changeContext } : {}),
    ...(implementation ? { implementation } : {}),
    ...(acceptanceVerification ? { acceptanceVerification } : {}),
  };
}

/**
 * A phase's implementation policy (Phase 8, `PhaseDef.implementation`).
 *
 * Two authoring rules worth being strict about here, where the author can see
 * them, rather than at 3am on an instance nobody is watching:
 *
 * - it requires a `changeContext`. The accepted proposal a realization targets
 *   is the one that selector resolves; a second selection mechanism would be a
 *   second answer to "which change is this realizing?";
 * - `maxAttempts` is bounded. The loop is `implement → verify → implement`,
 *   and the whole point of the bound is that it is the author's, is small, and
 *   exists.
 */
function validateImplementation(
  raw: unknown,
  ctx: string,
  changeContext: ChangeContextSpec | undefined,
): ImplementationPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: implementation must be an object`);
  }
  const v = raw as Record<string, unknown>;
  for (const k of Object.keys(v)) {
    if (
      k !== "maxAttempts" &&
      k !== "requireCurrentIntent" &&
      k !== "includePreserved" &&
      k !== "note"
    ) {
      throw new PipelineValidationError(`${ctx}: implementation has unknown key "${k}"`);
    }
  }
  if (!changeContext) {
    throw new PipelineValidationError(
      `${ctx}: an implementation phase must also declare changeContext — the accepted ChangeProposal it realizes is the one that selector resolves`,
    );
  }
  const out: ImplementationPolicy = {};
  if (v.maxAttempts !== undefined && v.maxAttempts !== null) {
    if (
      typeof v.maxAttempts !== "number" ||
      !Number.isInteger(v.maxAttempts) ||
      v.maxAttempts < 1 ||
      v.maxAttempts > REALIZATION_MAX_ATTEMPTS
    ) {
      throw new PipelineValidationError(
        `${ctx}: implementation.maxAttempts must be an integer between 1 and ${REALIZATION_MAX_ATTEMPTS}`,
      );
    }
    out.maxAttempts = v.maxAttempts;
  }
  for (const flag of ["requireCurrentIntent", "includePreserved"] as const) {
    if (v[flag] === undefined || v[flag] === null) continue;
    if (typeof v[flag] !== "boolean") {
      throw new PipelineValidationError(`${ctx}: implementation.${flag} must be a boolean`);
    }
    out[flag] = v[flag];
  }
  if (v.note !== undefined && v.note !== null) {
    if (typeof v.note !== "string" || !v.note.trim()) {
      throw new PipelineValidationError(`${ctx}: implementation.note must be a string`);
    }
    if (v.note.length > DISCOVERY_NOTE_MAX_CHARS) {
      throw new PipelineValidationError(
        `${ctx}: implementation.note exceeds ${DISCOVERY_NOTE_MAX_CHARS} characters`,
      );
    }
    out.note = v.note.trim();
  }
  return out;
}

/**
 * A phase's acceptance-verification policy (Phase 8,
 * `PhaseDef.acceptanceVerification`).
 *
 * Like the implementation half it requires a `changeContext`: the criteria a
 * run must answer for are exactly the accepted proposal's own, and there is no
 * second way to select them. `implementationPhase` is checked against the
 * whole graph in {@link validateRealizationPhases}.
 */
function validateAcceptanceVerification(
  raw: unknown,
  ctx: string,
  changeContext: ChangeContextSpec | undefined,
): AcceptanceVerificationPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: acceptanceVerification must be an object`);
  }
  const v = raw as Record<string, unknown>;
  for (const k of Object.keys(v)) {
    if (k !== "implementationPhase" && k !== "require" && k !== "note") {
      throw new PipelineValidationError(`${ctx}: acceptanceVerification has unknown key "${k}"`);
    }
  }
  if (!changeContext) {
    throw new PipelineValidationError(
      `${ctx}: an acceptanceVerification phase must also declare changeContext — its criteria are the accepted ChangeProposal's own`,
    );
  }
  if (typeof v.implementationPhase !== "string" || !v.implementationPhase.trim()) {
    throw new PipelineValidationError(
      `${ctx}: acceptanceVerification.implementationPhase must name the implementation phase it verifies`,
    );
  }
  const out: AcceptanceVerificationPolicy = {
    implementationPhase: v.implementationPhase.trim(),
  };
  if (v.require !== undefined && v.require !== null) {
    if (v.require !== "all" && v.require !== "behavioral") {
      throw new PipelineValidationError(
        `${ctx}: acceptanceVerification.require must be "all" | "behavioral"`,
      );
    }
    out.require = v.require;
  }
  if (v.note !== undefined && v.note !== null) {
    if (typeof v.note !== "string" || !v.note.trim()) {
      throw new PipelineValidationError(`${ctx}: acceptanceVerification.note must be a string`);
    }
    if (v.note.length > DISCOVERY_NOTE_MAX_CHARS) {
      throw new PipelineValidationError(
        `${ctx}: acceptanceVerification.note exceeds ${DISCOVERY_NOTE_MAX_CHARS} characters`,
      );
    }
    out.note = v.note.trim();
  }
  return out;
}

/**
 * A phase's change-intent policy (Phase 7, `PhaseDef.changeIntent`).
 *
 * The one rule worth being strict about at authoring time is the gate. Phase 7
 * exists so that a *requested* change is reviewed before it becomes canonical
 * semantics; an ungated change-intent phase is a pipeline that rewrites the
 * domain because somebody filed a ticket, and no later check can recover the
 * review that never happened. So it is refused here, where the author can see
 * it, rather than at 3am on an instance nobody is watching.
 */
function validateChangeIntent(
  raw: unknown,
  ctx: string,
  gated: boolean,
): ChangeIntentPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: changeIntent must be an object`);
  }
  const v = raw as Record<string, unknown>;
  for (const k of Object.keys(v)) {
    if (k !== "request" && k !== "kinds" && k !== "acceptanceCriteria" && k !== "note") {
      throw new PipelineValidationError(`${ctx}: changeIntent has unknown key "${k}"`);
    }
  }
  if (!gated) {
    throw new PipelineValidationError(
      `${ctx}: a changeIntent phase must be gated — a proposed change to the domain's semantics is reviewed before it becomes canonical`,
    );
  }
  const out: ChangeIntentPolicy = {};
  if (v.request !== undefined && v.request !== null) {
    try {
      out.request = validateChangeRequest(v.request, `${ctx}: changeIntent.request`);
    } catch (e) {
      throw new PipelineValidationError(
        e instanceof ChangeProposalError || e instanceof Error ? e.message : String(e),
      );
    }
  }
  if (v.kinds !== undefined && v.kinds !== null) {
    if (!Array.isArray(v.kinds) || v.kinds.length === 0) {
      throw new PipelineValidationError(
        `${ctx}: changeIntent.kinds must name at least one claim kind`,
      );
    }
    const kinds: ClaimKind[] = [];
    for (const [k, entry] of v.kinds.entries()) {
      if (typeof entry !== "string" || !CLAIM_KINDS.includes(entry as ClaimKind)) {
        throw new PipelineValidationError(
          `${ctx}: changeIntent.kinds[${k}] must be one of ${CLAIM_KINDS.join(" | ")}`,
        );
      }
      if (!kinds.includes(entry as ClaimKind)) kinds.push(entry as ClaimKind);
    }
    out.kinds = kinds;
  }
  if (v.acceptanceCriteria !== undefined && v.acceptanceCriteria !== null) {
    if (v.acceptanceCriteria !== "required" && v.acceptanceCriteria !== "warn") {
      throw new PipelineValidationError(
        `${ctx}: changeIntent.acceptanceCriteria must be "required" | "warn"`,
      );
    }
    out.acceptanceCriteria = v.acceptanceCriteria;
  }
  if (v.note !== undefined && v.note !== null) {
    if (typeof v.note !== "string" || !v.note.trim()) {
      throw new PipelineValidationError(`${ctx}: changeIntent.note must be a string`);
    }
    if (v.note.length > DISCOVERY_NOTE_MAX_CHARS) {
      throw new PipelineValidationError(
        `${ctx}: changeIntent.note exceeds ${DISCOVERY_NOTE_MAX_CHARS} characters`,
      );
    }
    out.note = v.note.trim();
  }
  return out;
}

/** A phase's downstream change-context selector (Phase 7,
 *  `PhaseDef.changeContext`). The named phase must exist and must be a
 *  dependency — checked across the whole graph in
 *  {@link validateChangeContextSelectors}. */
function validateChangeContext(raw: unknown, ctx: string): ChangeContextSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(
      `${ctx}: changeContext must be an object { fromPhase, requireReady? }`,
    );
  }
  const v = raw as Record<string, unknown>;
  for (const k of Object.keys(v)) {
    if (k !== "fromPhase" && k !== "requireReady") {
      throw new PipelineValidationError(`${ctx}: changeContext has unknown key "${k}"`);
    }
  }
  if (typeof v.fromPhase !== "string" || !v.fromPhase.trim()) {
    throw new PipelineValidationError(`${ctx}: changeContext.fromPhase must name a phase`);
  }
  const out: ChangeContextSpec = { fromPhase: v.fromPhase.trim() };
  if (v.requireReady !== undefined && v.requireReady !== null) {
    if (typeof v.requireReady !== "boolean") {
      throw new PipelineValidationError(`${ctx}: changeContext.requireReady must be a boolean`);
    }
    out.requireReady = v.requireReady;
  }
  return out;
}

/**
 * A phase's business-rule verification policy (Phase 6,
 * `PhaseDef.ruleVerification`).
 *
 * Deliberately tiny, because the interesting decision — *which* rules this
 * phase is accountable for — is not made here. It is made by the phase's (or
 * step's) `knowledgeContext`, which already resolves selectors against one
 * ledger snapshot and records durably what was supplied. This policy says only
 * that the phase must produce structured conformance results, which of the
 * supplied kinds need an outcome, and how strict `holds` is.
 */
function validateRuleVerification(raw: unknown, ctx: string): RuleVerificationPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: ruleVerification must be an object`);
  }
  const v = raw as Record<string, unknown>;
  for (const k of Object.keys(v)) {
    if (k !== "kinds" && k !== "holds" && k !== "note") {
      throw new PipelineValidationError(`${ctx}: ruleVerification has unknown key "${k}"`);
    }
  }
  const out: RuleVerificationPolicy = {};
  if (v.kinds !== undefined && v.kinds !== null) {
    if (!Array.isArray(v.kinds) || v.kinds.length === 0) {
      throw new PipelineValidationError(
        `${ctx}: ruleVerification.kinds must name at least one claim kind`,
      );
    }
    const kinds: ClaimKind[] = [];
    for (const [k, entry] of v.kinds.entries()) {
      if (typeof entry !== "string" || !CLAIM_KINDS.includes(entry as ClaimKind)) {
        throw new PipelineValidationError(
          `${ctx}: ruleVerification.kinds[${k}] must be one of ${CLAIM_KINDS.join(" | ")}`,
        );
      }
      if (!kinds.includes(entry as ClaimKind)) kinds.push(entry as ClaimKind);
    }
    out.kinds = kinds;
  }
  if (v.holds !== undefined && v.holds !== null) {
    if (v.holds !== "agent-evidence" && v.holds !== "deterministic-check") {
      throw new PipelineValidationError(
        `${ctx}: ruleVerification.holds must be "agent-evidence" | "deterministic-check"`,
      );
    }
    out.holds = v.holds;
  }
  if (v.note !== undefined && v.note !== null) {
    if (typeof v.note !== "string" || !v.note.trim()) {
      throw new PipelineValidationError(`${ctx}: ruleVerification.note must be a string`);
    }
    if (v.note.length > DISCOVERY_NOTE_MAX_CHARS) {
      throw new PipelineValidationError(
        `${ctx}: ruleVerification.note exceeds ${DISCOVERY_NOTE_MAX_CHARS} characters`,
      );
    }
    out.note = v.note.trim();
  }
  return out;
}

/**
 * A phase's business-rule discovery policy (Phase 5, `PhaseDef.discovery`).
 *
 * The scope is the part worth being strict about, because it is not just
 * prompt text: it is the containment rule every `source-code` evidence path
 * is checked against at intake and at commit. So its paths get the same
 * treatment as an artifact path — repository-relative, POSIX, no `..` — and
 * `"."` (the whole tree) has to be written out rather than being what an
 * empty list quietly means.
 */
function validateDiscovery(raw: unknown, ctx: string): DiscoveryPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineValidationError(`${ctx}: discovery must be an object { scope: { paths } }`);
  }
  const d = raw as Record<string, unknown>;
  for (const k of Object.keys(d)) {
    if (k !== "scope" && k !== "evidence") {
      throw new PipelineValidationError(`${ctx}: discovery has unknown key "${k}"`);
    }
  }
  if (!d.scope || typeof d.scope !== "object" || Array.isArray(d.scope)) {
    throw new PipelineValidationError(`${ctx}: discovery.scope must be an object { paths }`);
  }
  const raw_scope = d.scope as Record<string, unknown>;
  for (const k of Object.keys(raw_scope)) {
    if (k !== "paths" && k !== "label" && k !== "note") {
      throw new PipelineValidationError(`${ctx}: discovery.scope has unknown key "${k}"`);
    }
  }
  if (!Array.isArray(raw_scope.paths) || raw_scope.paths.length === 0) {
    throw new PipelineValidationError(
      `${ctx}: discovery.scope.paths must name at least one repository-relative path (use ["."] for the whole tree)`,
    );
  }
  if (raw_scope.paths.length > DISCOVERY_SCOPE_MAX_PATHS) {
    throw new PipelineValidationError(
      `${ctx}: discovery.scope.paths is capped at ${DISCOVERY_SCOPE_MAX_PATHS} paths`,
    );
  }
  const paths: string[] = [];
  for (const [i, entry] of raw_scope.paths.entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new PipelineValidationError(`${ctx}: discovery.scope.paths[${i}] must be a string`);
    }
    const value = entry.trim().replace(/\/+$/, "");
    const normalized = value === "" || value === "." ? "." : value;
    if (normalized !== "." && !validArtifactPath(normalized)) {
      throw new PipelineValidationError(
        `${ctx}: discovery.scope.paths[${i}] must be a repository-relative POSIX path inside the repository`,
      );
    }
    if (!paths.includes(normalized)) paths.push(normalized);
  }
  const scope: DiscoveryScope = { paths };
  if (raw_scope.label !== undefined && raw_scope.label !== null) {
    if (typeof raw_scope.label !== "string" || !raw_scope.label.trim()) {
      throw new PipelineValidationError(`${ctx}: discovery.scope.label must be a string`);
    }
    if (raw_scope.label.length > DISCOVERY_LABEL_MAX_CHARS) {
      throw new PipelineValidationError(
        `${ctx}: discovery.scope.label exceeds ${DISCOVERY_LABEL_MAX_CHARS} characters`,
      );
    }
    scope.label = raw_scope.label.trim();
  }
  if (raw_scope.note !== undefined && raw_scope.note !== null) {
    if (typeof raw_scope.note !== "string" || !raw_scope.note.trim()) {
      throw new PipelineValidationError(`${ctx}: discovery.scope.note must be a string`);
    }
    if (raw_scope.note.length > DISCOVERY_NOTE_MAX_CHARS) {
      throw new PipelineValidationError(
        `${ctx}: discovery.scope.note exceeds ${DISCOVERY_NOTE_MAX_CHARS} characters`,
      );
    }
    scope.note = raw_scope.note.trim();
  }
  const out: DiscoveryPolicy = { scope };
  if (d.evidence !== undefined && d.evidence !== null) {
    if (d.evidence !== "required" && d.evidence !== "warn") {
      throw new PipelineValidationError(`${ctx}: discovery.evidence must be "required" | "warn"`);
    }
    out.evidence = d.evidence;
  }
  return out;
}

const KNOWLEDGE_DELTA_MODES = new Set<NonNullable<PhaseDef["knowledgeDelta"]>>([
  "optional",
  "required",
]);

/**
 * Whether a phase's launch depends on the KnowledgeDelta channel being
 * writable (see `PhaseDef.knowledgeDelta`). Undefined/null = optional, the
 * protocol as every phase has had it: offered, never a reason not to launch.
 * Says nothing about whether the agent must write a delta.
 */
function validateKnowledgeDelta(raw: unknown, ctx: string): PhaseDef["knowledgeDelta"] {
  if (raw === undefined || raw === null) return undefined;
  if (!KNOWLEDGE_DELTA_MODES.has(raw as NonNullable<PhaseDef["knowledgeDelta"]>)) {
    throw new PipelineValidationError(
      `${ctx}: knowledgeDelta must be ${[...KNOWLEDGE_DELTA_MODES].join(" | ")}`,
    );
  }
  return raw as PhaseDef["knowledgeDelta"];
}

const RETRYABLE: readonly string[] = [
  "spawn",
  "exit-code",
  "signal",
  "timeout",
  "verification",
  "knowledge-delta",
  "knowledge-context-integrity",
  "rule-verification",
];

function validateRetry(raw: unknown, i: number) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object")
    throw new PipelineValidationError(`phase ${i}: retry must be an object`);
  const r = raw as Record<string, unknown>;
  const attempts = Number(r.attempts);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new PipelineValidationError(`phase ${i}: retry.attempts must be an integer 1-10`);
  }
  const backoffSeconds = r.backoffSeconds === undefined ? 30 : Number(r.backoffSeconds);
  if (!Number.isFinite(backoffSeconds) || backoffSeconds < 0 || backoffSeconds > 3600) {
    throw new PipelineValidationError(`phase ${i}: retry.backoffSeconds must be 0-3600`);
  }
  let retryOn: string[] | undefined;
  if (r.retryOn !== undefined) {
    if (!Array.isArray(r.retryOn) || r.retryOn.some((c) => !RETRYABLE.includes(String(c)))) {
      throw new PipelineValidationError(
        `phase ${i}: retry.retryOn must be a list of ${RETRYABLE.join(" | ")}`,
      );
    }
    retryOn = [...new Set(r.retryOn.map(String))];
  }
  return {
    attempts,
    backoffSeconds,
    ...(retryOn ? { retryOn: retryOn as RetryableClass[] } : {}),
  };
}

/**
 * Whole-graph checks: the DAG first (a dangling edge or a cycle is reported as
 * itself), then the routes, which assume every edge names a phase that exists.
 */
function validateGraph(phases: PhaseDef[]): void {
  try {
    validateDag(phases);
  } catch (e) {
    throw new PipelineValidationError(e instanceof DagValidationError ? e.message : String(e));
  }
  routeChecked(() => validateRoutes(phases));
  validateProducedByPhaseSelectors(phases);
  validateChangeContextSelectors(phases);
  validateRealizationPhases(phases);
}

/**
 * The two halves of a change realization name each other correctly (Phase 8).
 *
 * A realization is `implement → verify`, and the link between the halves is
 * what makes "which implementation state am I verifying?" answerable at all.
 * Every condition here is an authoring error that would otherwise surface as
 * a launch refusal on a live instance:
 *
 * - an `implementation` phase needs exactly one verifier, because two would be
 *   two answers to whether the change is realized and none would be one;
 * - `acceptanceVerification.implementationPhase` must name a real
 *   `implementation` phase, and must be a dependency, so the implementation is
 *   guaranteed to have happened before its verification looks at the tree;
 * - both halves must target the **same** accepted proposal, or the criteria
 *   being answered would belong to a different change from the one being
 *   implemented.
 */
function validateRealizationPhases(phases: PhaseDef[]): void {
  const needs = resolveNeeds(phases);
  const known = new Map(phases.map((p) => [p.id, p]));
  const ancestorsOf = (id: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(needs.get(id) ?? [])];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(needs.get(next) ?? []));
    }
    return seen;
  };
  for (const phase of phases) {
    const spec = phase.acceptanceVerification;
    if (!spec) continue;
    const where = `phase "${phase.id}"`;
    const impl = known.get(spec.implementationPhase);
    if (!impl) {
      throw new PipelineValidationError(
        `${where}: acceptanceVerification.implementationPhase names unknown phase "${spec.implementationPhase}"`,
      );
    }
    if (impl.id === phase.id) {
      throw new PipelineValidationError(
        `${where}: acceptanceVerification.implementationPhase cannot name its own phase`,
      );
    }
    if (!impl.implementation) {
      throw new PipelineValidationError(
        `${where}: acceptanceVerification.implementationPhase names "${impl.id}", which declares no implementation policy and so drives no change realization`,
      );
    }
    if (!ancestorsOf(phase.id).has(impl.id)) {
      throw new PipelineValidationError(
        `${where}: acceptanceVerification.implementationPhase names "${impl.id}", which is not a dependency of this phase; add it to needs so the implementation is guaranteed to have happened first`,
      );
    }
    if (phase.changeContext?.fromPhase !== impl.changeContext?.fromPhase) {
      throw new PipelineValidationError(
        `${where}: it verifies "${impl.id}" but resolves its accepted change from a different phase ("${phase.changeContext?.fromPhase}" vs "${impl.changeContext?.fromPhase}"); both halves of a realization must answer for the same accepted change`,
      );
    }
  }
  for (const phase of phases) {
    if (!phase.implementation) continue;
    const verifiers = phases.filter(
      (p) => p.acceptanceVerification?.implementationPhase === phase.id,
    );
    if (verifiers.length === 0) {
      throw new PipelineValidationError(
        `phase "${phase.id}": an implementation phase needs a later phase declaring acceptanceVerification.implementationPhase: "${phase.id}" — without one nothing would ever decide whether the change was realized`,
      );
    }
    if (verifiers.length > 1) {
      throw new PipelineValidationError(
        `phase "${phase.id}": ${verifiers.length} phases verify it (${verifiers.map((v) => `"${v.id}"`).join(", ")}); a change realization has exactly one verification half`,
      );
    }
  }
}

/**
 * `changeContext.fromPhase` names a change-intent phase of *this* pipeline
 * that is guaranteed to have run — and been approved — first (Phase 7 §23).
 *
 * The same three conditions as a `fromPhases` knowledge selector, for the same
 * reasons, plus one of Phase 7's own: the named phase must actually declare
 * `changeIntent`. A selector pointing at a phase that never produces a
 * proposal would refuse every launch at runtime, which is an authoring error
 * that should be reported when the pipeline is saved.
 */
function validateChangeContextSelectors(phases: PhaseDef[]): void {
  const needs = resolveNeeds(phases);
  const known = new Map(phases.map((p) => [p.id, p]));
  const ancestorsOf = (id: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(needs.get(id) ?? [])];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(needs.get(next) ?? []));
    }
    return seen;
  };
  for (const phase of phases) {
    const spec = phase.changeContext;
    if (!spec) continue;
    const where = `phase "${phase.id}"`;
    const source = known.get(spec.fromPhase);
    if (!source) {
      throw new PipelineValidationError(
        `${where}: changeContext.fromPhase names unknown phase "${spec.fromPhase}"`,
      );
    }
    if (spec.fromPhase === phase.id) {
      throw new PipelineValidationError(
        `${where}: changeContext.fromPhase cannot name its own phase`,
      );
    }
    if (!source.changeIntent) {
      throw new PipelineValidationError(
        `${where}: changeContext.fromPhase names "${spec.fromPhase}", which is not a changeIntent phase and so produces no ChangeProposal`,
      );
    }
    if (!ancestorsOf(phase.id).has(spec.fromPhase)) {
      throw new PipelineValidationError(
        `${where}: changeContext.fromPhase names "${spec.fromPhase}", which is not a dependency of this phase; add it to needs so it is guaranteed to have been accepted first`,
      );
    }
  }
}

/**
 * `knowledgeContext.fromPhases` names a phase of *this* pipeline that is
 * guaranteed to have run first (Phase 5 §downstream selection).
 *
 * Both halves are authoring errors and both are caught here, where the whole
 * graph is in hand:
 *
 * - **The phase must exist.** A typo would otherwise surface as a refused
 *   launch, at 3am, on an instance nobody is watching.
 * - **It must be a transitive dependency.** "The claims phase X committed"
 *   only means something once X has committed them; two phases that merely
 *   sit side by side in the list have no ordering, so a selector across them
 *   would be a race. Reachability through `needs` — which, for a linear
 *   pipeline, is exactly "an earlier phase" — is the condition that makes the
 *   handoff deterministic.
 */
function validateProducedByPhaseSelectors(phases: PhaseDef[]): void {
  const needs = resolveNeeds(phases);
  const known = new Set(phases.map((p) => p.id));
  /** Every phase that must finish before `id`, transitively. */
  const ancestorsOf = (id: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(needs.get(id) ?? [])];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(needs.get(next) ?? []));
    }
    return seen;
  };
  for (const phase of phases) {
    const specs: Array<{ where: string; spec: KnowledgeContextSpec }> = [];
    if (phase.knowledgeContext) {
      specs.push({ where: `phase "${phase.id}"`, spec: phase.knowledgeContext });
    }
    for (const step of phase.steps) {
      if (step.knowledgeContext) {
        specs.push({
          where: `phase "${phase.id}": step "${step.name}"`,
          spec: step.knowledgeContext,
        });
      }
    }
    if (specs.length === 0) continue;
    const ancestors = ancestorsOf(phase.id);
    for (const { where, spec } of specs) {
      for (const sel of spec.fromPhases ?? []) {
        if (!known.has(sel.phaseId)) {
          throw new PipelineValidationError(
            `${where}: knowledgeContext.fromPhases names unknown phase "${sel.phaseId}"`,
          );
        }
        if (sel.phaseId === phase.id) {
          throw new PipelineValidationError(
            `${where}: knowledgeContext.fromPhases cannot name its own phase`,
          );
        }
        if (!ancestors.has(sel.phaseId)) {
          throw new PipelineValidationError(
            `${where}: knowledgeContext.fromPhases names "${sel.phaseId}", which is not a dependency of this phase; add it to needs so it is guaranteed to have committed first`,
          );
        }
      }
    }
  }
}

export function validatePipelineInput(raw: unknown): PipelineInput {
  if (!raw || typeof raw !== "object") throw new PipelineValidationError("body required");
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim())
    throw new PipelineValidationError("name is required");
  if (!Array.isArray(r.phases) || r.phases.length === 0) {
    throw new PipelineValidationError("pipeline needs at least one phase");
  }
  const phases = r.phases.map((p, i) => validatePhase(p, i));
  // A cycle or a dangling edge is a 400 at authoring time. Without this it is
  // an instance that starts and then simply never finishes, which is how a DAG
  // executor fails when nobody checks.
  validateGraph(phases);
  const trigger = r.trigger == null ? null : validateTrigger(r.trigger, { allowWindowed: true });
  const overlapPolicy = r.overlapPolicy === "allow" ? "allow" : "skip";
  const enabled = r.enabled === undefined ? true : Boolean(r.enabled);
  const input: PipelineInput = { name: r.name.trim(), phases, trigger, enabled, overlapPolicy };
  if (r.model !== undefined && r.model !== null) input.model = validateModel(r.model, "pipeline");
  if (r.reasoningEffort !== undefined && r.reasoningEffort !== null) {
    input.reasoningEffort = validateReasoningEffort(r.reasoningEffort, "pipeline");
  }
  const runtime = validateRuntime(r.runtime, "pipeline");
  if (runtime) input.runtime = runtime;
  const capabilities = validateCapabilities(r.capabilities, "pipeline");
  if (capabilities) input.capabilities = capabilities;
  const workspace = validateWorkspace(r.workspace, "pipeline");
  if (workspace) input.workspace = workspace;
  const knowledgeScope = validateKnowledgeScope(r.knowledgeScope, "pipeline");
  if (knowledgeScope) input.knowledgeScope = knowledgeScope;
  assertCandidatesRunnable(phases, workspace);
  const contextLimits = validateContextLimits(r.contextLimits, "pipeline");
  if (contextLimits) input.contextLimits = contextLimits;
  const memory = validateMemory(r.memory, "pipeline");
  if (memory) input.memory = memory;
  return input;
}

export function validatePipelinePatch(raw: unknown): Partial<PipelineInput> {
  if (!raw || typeof raw !== "object") throw new PipelineValidationError("body required");
  const r = raw as Record<string, unknown>;
  const patch: Partial<PipelineInput> = {};
  if ("name" in r) {
    if (typeof r.name !== "string" || !r.name.trim()) {
      throw new PipelineValidationError("name must be a non-empty string");
    }
    patch.name = r.name.trim();
  }
  if ("phases" in r) {
    if (!Array.isArray(r.phases) || r.phases.length === 0) {
      throw new PipelineValidationError("pipeline needs at least one phase");
    }
    patch.phases = r.phases.map((p, i) => validatePhase(p, i));
    // A patched phase list replaces the whole graph, so it gets the whole
    // graph's checks — otherwise routing could only be broken by PUT.
    validateGraph(patch.phases);
  }
  if ("trigger" in r)
    patch.trigger = r.trigger == null ? null : validateTrigger(r.trigger, { allowWindowed: true });
  if ("enabled" in r) patch.enabled = Boolean(r.enabled);
  if ("overlapPolicy" in r) patch.overlapPolicy = r.overlapPolicy === "allow" ? "allow" : "skip";
  if ("model" in r) patch.model = r.model == null ? undefined : validateModel(r.model, "pipeline");
  if ("reasoningEffort" in r) {
    patch.reasoningEffort =
      r.reasoningEffort == null
        ? undefined
        : validateReasoningEffort(r.reasoningEffort, "pipeline");
  }
  if ("runtime" in r) patch.runtime = validateRuntime(r.runtime, "pipeline");
  if ("capabilities" in r) patch.capabilities = validateCapabilities(r.capabilities, "pipeline");
  if ("workspace" in r) patch.workspace = validateWorkspace(r.workspace, "pipeline");
  if ("knowledgeScope" in r)
    patch.knowledgeScope = validateKnowledgeScope(r.knowledgeScope, "pipeline");
  if ("contextLimits" in r)
    patch.contextLimits = validateContextLimits(r.contextLimits, "pipeline");
  if ("memory" in r) patch.memory = validateMemory(r.memory, "pipeline");
  return patch;
}

export const readPipelines = store.read;
const writePipelines = store.write;

/**
 * `after.pipelineId` checks that only `createPipeline`/`updatePipeline` can
 * make, because only they hold every other definition:
 *
 *  - the source must exist,
 *  - a pipeline may not chain off itself, and
 *  - a *direct* two-node cycle (A after B, B after A) is refused; a longer
 *    cycle through several pipelines is not detected here — the scheduler's
 *    chain pass only ever fires an instance once per source, so a longer
 *    cycle runs down, it does not spin.
 */
async function assertAfterTriggerValid(id: string, trigger: Trigger): Promise<void> {
  if (trigger.kind !== "after") return;
  if (trigger.pipelineId === id) {
    throw new PipelineValidationError("a pipeline cannot chain after itself");
  }
  const others = await readPipelines();
  const source = others.find((p) => p.id === trigger.pipelineId);
  if (!source) {
    throw new PipelineValidationError(
      `after trigger names an unknown pipeline: ${trigger.pipelineId}`,
    );
  }
  if (source.trigger?.kind === "after" && source.trigger.pipelineId === id) {
    throw new PipelineValidationError(
      `after trigger would create a cycle: "${source.name}" already fires after this pipeline`,
    );
  }
}

export async function createPipeline(
  input: PipelineInput,
  now: Date,
  id: string,
): Promise<PipelineDefinition> {
  if (input.trigger) await assertAfterTriggerValid(id, input.trigger);
  const iso = now.toISOString();
  const def: PipelineDefinition = {
    id,
    name: input.name,
    phases: input.phases,
    trigger: input.trigger,
    enabled: input.enabled ?? true,
    overlapPolicy: input.overlapPolicy ?? "skip",
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.knowledgeScope ? { knowledgeScope: input.knowledgeScope } : {}),
    ...(input.contextLimits ? { contextLimits: input.contextLimits } : {}),
    ...(input.memory ? { memory: input.memory } : {}),
    // Minted on first save of a webhook trigger; rotated only via the
    // dedicated endpoint, never by an ordinary edit.
    ...(input.trigger?.kind === "webhook" ? { hookToken: mintHookToken() } : {}),
    lastStartedAt: null,
    createdAt: iso,
    updatedAt: iso,
  };
  return withStoreLock(async () => {
    const list = await readPipelines();
    list.push(def);
    await writePipelines(list);
    return def;
  });
}

export async function updatePipeline(
  id: string,
  patch: Partial<PipelineInput>,
  now: Date,
): Promise<PipelineDefinition | null> {
  if (patch.trigger) await assertAfterTriggerValid(id, patch.trigger);
  return withStoreLock(async () => {
    const list = await readPipelines();
    const idx = list.findIndex((d) => d.id === id);
    if (idx === -1) return null;
    const merged: PipelineDefinition = {
      ...list[idx],
      ...("name" in patch ? { name: patch.name! } : {}),
      ...("phases" in patch ? { phases: patch.phases! } : {}),
      ...("trigger" in patch ? { trigger: patch.trigger! } : {}),
      ...("enabled" in patch ? { enabled: patch.enabled! } : {}),
      ...("overlapPolicy" in patch ? { overlapPolicy: patch.overlapPolicy! } : {}),
      ...("model" in patch ? { model: patch.model } : {}),
      ...("reasoningEffort" in patch ? { reasoningEffort: patch.reasoningEffort } : {}),
      updatedAt: now.toISOString(),
    };
    // An explicit `runtime: null` clears the override; spreading it would leave
    // a present-and-null key the resolver has to keep stepping over.
    if ("runtime" in patch) {
      if (patch.runtime) merged.runtime = patch.runtime;
      else delete merged.runtime;
    }
    // Same story for `capabilities`: an empty object `{}` is a meaningful,
    // truthy profile ("no MCP servers, no extra directories, ..."), while
    // null/undefined clears the override back to the pipeline's own default.
    if ("capabilities" in patch) {
      if (patch.capabilities) merged.capabilities = patch.capabilities;
      else delete merged.capabilities;
    }
    // And for `workspace`: null/undefined clears the pipeline-wide isolation
    // policy rather than leaving a present-and-null key behind.
    if ("workspace" in patch) {
      if (patch.workspace) merged.workspace = patch.workspace;
      else delete merged.workspace;
    }
    // And for `knowledgeScope`: clearing it makes the pipeline unscoped again.
    // Knowledge it already wrote keeps the scope it was written under — a
    // definition edit never retargets ownership of what is already canonical.
    if ("knowledgeScope" in patch) {
      if (patch.knowledgeScope) merged.knowledgeScope = patch.knowledgeScope;
      else delete merged.knowledgeScope;
    }
    // Same null-clears-the-override story for contextLimits and memory.
    if ("contextLimits" in patch) {
      if (patch.contextLimits) merged.contextLimits = patch.contextLimits;
      else delete merged.contextLimits;
    }
    if ("memory" in patch) {
      if (patch.memory) merged.memory = patch.memory;
      else delete merged.memory;
    }
    // Mint a hook token the first time this pipeline's trigger becomes
    // "webhook"; keep whatever token it already had otherwise.
    if (merged.trigger?.kind === "webhook" && !merged.hookToken) {
      merged.hookToken = mintHookToken();
    }
    // A PATCH can carry phases without a workspace (or the other way round), so
    // the candidate requirements are re-checked against what the save actually
    // produces rather than against the fragment that was sent.
    assertCandidatesRunnable(merged.phases, merged.workspace);
    list[idx] = merged;
    await writePipelines(list);
    return merged;
  });
}

export async function deletePipeline(id: string): Promise<boolean> {
  return withStoreLock(async () => {
    const list = await readPipelines();
    const next = list.filter((d) => d.id !== id);
    if (next.length === list.length) return false;
    await writePipelines(next);
    return true;
  });
}

export async function markPipelineStarted(id: string, atISO: string): Promise<void> {
  return withStoreLock(async () => {
    const list = await readPipelines();
    const idx = list.findIndex((d) => d.id === id);
    if (idx === -1) return;
    list[idx] = { ...list[idx], lastStartedAt: atISO };
    await writePipelines(list);
  });
}

/**
 * Mints a fresh `hookToken`, invalidating whatever URL/token combination was
 * handed out before. Only reachable via
 * `POST /api/pipelines/:id/hook-token/rotate` — an ordinary save never
 * regenerates a working hook.
 */
export async function rotatePipelineHookToken(
  id: string,
  now: Date,
): Promise<PipelineDefinition | null> {
  return withStoreLock(async () => {
    const list = await readPipelines();
    const idx = list.findIndex((d) => d.id === id);
    if (idx === -1) return null;
    if (list[idx].trigger?.kind !== "webhook") {
      throw new PipelineValidationError("pipeline does not have a webhook trigger");
    }
    const merged: PipelineDefinition = {
      ...list[idx],
      hookToken: mintHookToken(),
      updatedAt: now.toISOString(),
    };
    list[idx] = merged;
    await writePipelines(list);
    return merged;
  });
}
