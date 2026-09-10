import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { validateTrigger } from "./schedules.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import type { Dependency, PhaseDef, PhaseStep, PipelineDefinition } from "./pipelineTypes.js";
import type {
  CapabilityProfile,
  EnvPolicy,
  McpServerSpec,
  PhaseCheck,
  RetryableClass,
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
import type { AgentRuntimeId, ReasoningEffort } from "@argus/contracts";

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
  const capabilities = validateCapabilities(s.capabilities, stepCtx);
  if (capabilities) step.capabilities = capabilities;

  return step;
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
  const capabilities = validateCapabilities(p.capabilities, `phase ${i}`);
  const checks = validateChecks(p.checks, `phase ${i}`);

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
    ...(capabilities ? { capabilities } : {}),
    ...(checks ? { checks } : {}),
  };
}

const RETRYABLE: readonly string[] = ["spawn", "exit-code", "signal", "timeout", "verification"];

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
  return patch;
}

export const readPipelines = store.read;
const writePipelines = store.write;

export async function createPipeline(
  input: PipelineInput,
  now: Date,
  id: string,
): Promise<PipelineDefinition> {
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
