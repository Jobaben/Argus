import { normalizeNeeds } from "./routing.js";
import type {
  Dependency,
  DependencyEdge,
  PhaseDef,
  PhaseResult,
  PhaseStep,
  ResultSchema,
  RouteCondition,
  RoutePredicate,
} from "./pipelineTypes.js";

/**
 * Authoring-time validation for outcome routing.
 *
 * A conditional edge is a promise: *this* field of *that* phase's result will
 * decide whether this work happens. Both halves of the promise are declared in
 * the same definition, so both can be checked before it is saved — the source
 * phase must actually publish a result, the referenced field must exist in its
 * schema, and the compared value must be one the field can hold.
 *
 * That matters more than the usual argument for input validation. An unchecked
 * conditional edge does not fail loudly: it produces an instance that runs, does
 * something defensible-looking, and takes a branch nobody can explain — a
 * predicate against a field the agent never writes is simply false, forever, and
 * a typo in an enum value silently means "always take the other branch". The
 * cost of catching that at save time is one 400 naming the phase; the cost of
 * not catching it is a workflow that is quietly wrong in production.
 *
 * Everything here is pure and throws {@link RouteAuthoringError}; pipeline
 * validation re-wraps it so the existing `400` mapping covers it, exactly as it
 * does for rubric and DAG errors.
 */

export class RouteAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteAuthoringError";
  }
}

const SCHEMA_TYPES: ResultSchema["type"][] = [
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
];

const OPERATORS: RoutePredicate["operator"][] = ["equals", "not-equals", "one-of", "exists"];

/** Matches `produces`: a short name safe to interpolate as `{{artifacts.<name>}}`. */
const ARTIFACT_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Deep enough for a realistic decision object, shallow enough to stay readable. */
const MAX_SCHEMA_DEPTH = 8;

function fail(message: string): never {
  throw new RouteAuthoringError(message);
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

// ── Result declarations ─────────────────────────────────────────────────────

/**
 * Validate one phase's `result` declaration against the phase's own steps.
 *
 * `resultStep` is optional for a one-step phase and required beyond that: the
 * point of naming it is that two concurrent sibling steps cannot race to publish
 * one phase-level decision, and "whichever wrote last" is not a routing rule.
 */
export function validatePhaseResult(
  raw: unknown,
  phaseId: string,
  steps: PhaseStep[],
): PhaseResult {
  const ctx = `phase "${phaseId}": result`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${ctx} must be an object`);
  const r = raw as Record<string, unknown>;
  if (typeof r.artifact !== "string" || !ARTIFACT_RE.test(r.artifact)) {
    fail(`${ctx}.artifact must be a short name of letters, digits, - or _`);
  }
  if (r.schema === undefined || r.schema === null) fail(`${ctx}.schema is required`);
  const schema = validateResultSchema(r.schema, `${ctx}.schema`, 0);

  let resultStep: string | undefined;
  if (r.resultStep !== undefined && r.resultStep !== null) {
    if (typeof r.resultStep !== "string" || !r.resultStep.trim()) {
      fail(`${ctx}.resultStep must be a step name`);
    }
    resultStep = r.resultStep.trim();
    if (!steps.some((s) => s.name === resultStep)) {
      fail(`${ctx}.resultStep "${resultStep}" is not a step of this phase`);
    }
  } else if (steps.length > 1) {
    fail(`${ctx}.resultStep is required when a phase has more than one step`);
  }

  return { artifact: r.artifact, ...(resultStep ? { resultStep } : {}), schema };
}

/**
 * Validate the small recursive result schema.
 *
 * Deliberately not a JSON Schema subset chosen by taste: it is exactly what
 * {@link validateResult} enforces at runtime and what a predicate path can
 * traverse. Anything broader would be a schema the engine cannot check.
 */
export function validateResultSchema(raw: unknown, ctx: string, depth: number): ResultSchema {
  if (depth > MAX_SCHEMA_DEPTH) fail(`${ctx} nests deeper than ${MAX_SCHEMA_DEPTH} levels`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${ctx} must be an object`);
  const s = raw as Record<string, unknown>;
  if (!SCHEMA_TYPES.includes(s.type as ResultSchema["type"])) {
    fail(`${ctx}.type must be ${SCHEMA_TYPES.join(" | ")}`);
  }
  const type = s.type as ResultSchema["type"];
  const out: ResultSchema = { type };

  if (s.properties !== undefined && s.properties !== null) {
    if (type !== "object") fail(`${ctx}.properties is only meaningful on an object`);
    if (typeof s.properties !== "object" || Array.isArray(s.properties)) {
      fail(`${ctx}.properties must be an object of property schemas`);
    }
    const properties: Record<string, ResultSchema> = {};
    for (const [name, propertySchema] of Object.entries(s.properties as Record<string, unknown>)) {
      properties[name] = validateResultSchema(propertySchema, `${ctx}.${name}`, depth + 1);
    }
    out.properties = properties;
  }

  if (s.required !== undefined && s.required !== null) {
    if (type !== "object") fail(`${ctx}.required is only meaningful on an object`);
    if (!Array.isArray(s.required) || s.required.some((n) => typeof n !== "string" || !n.trim())) {
      fail(`${ctx}.required must be a list of property names`);
    }
    out.required = (s.required as string[]).map((n) => n.trim());
  }

  if (s.items !== undefined && s.items !== null) {
    if (type !== "array") fail(`${ctx}.items is only meaningful on an array`);
    out.items = validateResultSchema(s.items, `${ctx}.items`, depth + 1);
  }

  if (s.enum !== undefined && s.enum !== null) {
    if (!Array.isArray(s.enum) || s.enum.length === 0 || !s.enum.every(isScalar)) {
      fail(`${ctx}.enum must be a non-empty list of scalar values`);
    }
    for (const value of s.enum) {
      if (!valueMatchesType(type, value)) {
        fail(`${ctx}.enum values must match the declared ${type} type`);
      }
    }
    out.enum = s.enum as ResultSchema["enum"];
  }

  return out;
}

function valueMatchesType(type: ResultSchema["type"], value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "object":
    case "array":
      return false;
  }
}

// ── Dependency edges ────────────────────────────────────────────────────────

/**
 * Validate one `needs` entry, preserving the legacy string form byte for byte.
 *
 * A definition authored before routing existed must come back out of validation
 * exactly as it went in — a string that quietly became `{ phase: "x" }` would
 * rewrite every stored pipeline the first time it was patched.
 */
export function validateDependency(raw: unknown, ctx: string): Dependency {
  if (typeof raw === "string") {
    if (!raw.trim()) fail(`${ctx}: a dependency phase id is required`);
    return raw.trim();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${ctx}: needs entries must be a phase id or a dependency object`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.phase !== "string" || !e.phase.trim()) {
    fail(`${ctx}: a dependency phase id is required`);
  }
  const edge: DependencyEdge = { phase: e.phase.trim() };
  const edgeCtx = `${ctx}: needs "${edge.phase}"`;

  if (e.allowSkipped !== undefined && e.allowSkipped !== null) {
    if (typeof e.allowSkipped !== "boolean") fail(`${edgeCtx}: allowSkipped must be a boolean`);
    if (e.allowSkipped) edge.allowSkipped = true;
  }
  if (e.when !== undefined && e.when !== null) edge.when = validateCondition(e.when, edgeCtx);
  return edge;
}

/** Validate a route condition's own shape. Cross-phase checks come later. */
function validateCondition(raw: unknown, ctx: string): RouteCondition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${ctx}: when must be an object`);
  const w = raw as Record<string, unknown>;
  const when: RouteCondition = {};

  if (w.group !== undefined && w.group !== null) {
    if (typeof w.group !== "string" || !w.group.trim()) fail(`${ctx}: group must be a name`);
    when.group = w.group.trim();
  }
  for (const flag of ["exclusive", "required"] as const) {
    if (w[flag] === undefined || w[flag] === null) continue;
    if (typeof w[flag] !== "boolean") fail(`${ctx}: ${flag} must be a boolean`);
    if (w[flag]) when[flag] = true;
  }
  if (w.default !== undefined && w.default !== null) {
    if (w.default !== true) fail(`${ctx}: default must be true or omitted`);
    when.default = true;
  }
  if (w.predicate !== undefined && w.predicate !== null) {
    when.predicate = validatePredicate(w.predicate, ctx);
  }

  if (when.default && when.predicate) {
    fail(`${ctx}: a default route cannot also carry a predicate`);
  }
  if (!when.default && !when.predicate) {
    fail(`${ctx}: a condition needs a predicate or default: true`);
  }
  if (!when.group && (when.default || when.exclusive || when.required)) {
    fail(`${ctx}: default, exclusive and required require a group`);
  }
  return when;
}

function validatePredicate(raw: unknown, ctx: string): RoutePredicate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${ctx}: predicate must be an object`);
  }
  const p = raw as Record<string, unknown>;
  if (
    !Array.isArray(p.path) ||
    p.path.length === 0 ||
    p.path.some((seg) => typeof seg !== "string" || !seg.trim())
  ) {
    fail(`${ctx}: predicate path must be a non-empty list of property names`);
  }
  if (!OPERATORS.includes(p.operator as RoutePredicate["operator"])) {
    fail(`${ctx}: predicate operator must be ${OPERATORS.join(" | ")}`);
  }
  const operator = p.operator as RoutePredicate["operator"];
  const path = (p.path as string[]).map((seg) => seg.trim());
  const hasValue = Object.hasOwn(p, "value") && p.value !== undefined;

  if (operator === "exists") {
    if (hasValue) fail(`${ctx}: an exists predicate takes no value`);
    return { path, operator };
  }
  if (!hasValue) fail(`${ctx}: a ${operator} predicate needs a value`);
  if (operator === "one-of") {
    if (!Array.isArray(p.value) || p.value.length === 0 || !p.value.every(isScalar)) {
      fail(`${ctx}: a one-of predicate value must be a list of scalar values`);
    }
  } else if (!isScalar(p.value)) {
    fail(`${ctx}: a ${operator} predicate value must be a scalar value`);
  }
  return { path, operator, value: p.value as RoutePredicate["value"] };
}

// ── Cross-phase route checks ────────────────────────────────────────────────

/** The schema at a predicate path, or null when the path is not declared. */
export function schemaAt(schema: ResultSchema, path: string[]): ResultSchema | null {
  let current: ResultSchema = schema;
  for (const segment of path) {
    if (current.type !== "object") return null;
    const next = current.properties?.[segment];
    if (!next) return null;
    current = next;
  }
  return current;
}

interface GroupMember {
  target: string;
  source: string;
  when: RouteCondition;
}

/**
 * Prove every conditional edge in the graph can be evaluated.
 *
 * Runs after the phases themselves validate (so ids and schemas are known) and
 * after the DAG check (so a dangling edge is reported as a dangling edge rather
 * than as an unevaluable condition).
 */
export function validateRoutes(phases: PhaseDef[]): void {
  const byId = new Map(phases.map((p) => [p.id, p]));
  const groups = new Map<string, GroupMember[]>();

  for (const target of phases) {
    for (const edge of normalizeNeeds(target.needs)) {
      if (!edge.when) continue;
      const source = byId.get(edge.phase);
      // A dangling edge is validateDag's error to report, with its message.
      if (!source) continue;
      const ctx = `phase "${target.id}"`;
      if (!source.result) {
        fail(
          `${ctx}: needs "${edge.phase}" conditionally, but phase "${edge.phase}" declares no result`,
        );
      }
      if (edge.when.predicate) {
        checkPredicate(ctx, edge.phase, source.result.schema, edge.when.predicate);
      }
      if (edge.when.group) {
        const members = groups.get(edge.when.group) ?? [];
        members.push({ target: target.id, source: edge.phase, when: edge.when });
        groups.set(edge.when.group, members);
      }
    }
  }

  for (const [name, members] of groups) checkGroup(name, members);
}

function checkPredicate(
  ctx: string,
  sourceId: string,
  schema: ResultSchema,
  predicate: RoutePredicate,
): void {
  const printed = predicate.path.join(".");
  const leaf = schemaAt(schema, predicate.path);
  if (!leaf) {
    fail(
      `${ctx}: condition path "${printed}" is not declared by phase "${sourceId}"'s result schema`,
    );
  }
  if (predicate.operator === "exists") return;
  if (leaf.type === "object" || leaf.type === "array") {
    fail(`${ctx}: condition on "${printed}" cannot compare a ${leaf.type} value`);
  }
  const candidates =
    predicate.operator === "one-of" ? (predicate.value as unknown[]) : [predicate.value];
  for (const candidate of candidates) {
    if (!valueMatchesType(leaf.type, candidate)) {
      fail(`${ctx}: condition value for "${printed}" must be a ${leaf.type}`);
    }
    if (leaf.enum && !leaf.enum.some((allowed) => Object.is(allowed, candidate))) {
      fail(`${ctx}: condition value for "${printed}" is not one of its declared enum values`);
    }
  }
}

/**
 * A group is one decision, so its members must agree on what kind of decision
 * it is: one source result, one default at most, and one reading of
 * exclusive/required. Disagreeing members would still *evaluate* — the runtime
 * takes any member's flag — which is precisely why it has to be rejected here
 * rather than discovered from a branch that ran when it shouldn't have.
 */
function checkGroup(name: string, members: GroupMember[]): void {
  const ctx = `route group "${name}"`;
  const sources = new Set(members.map((m) => m.source));
  if (sources.size > 1) {
    fail(`${ctx} spans more than one source phase (${[...sources].sort().join(", ")})`);
  }
  const defaults = members.filter((m) => m.when.default);
  if (defaults.length > 1) {
    fail(`${ctx} declares more than one default route`);
  }
  for (const flag of ["exclusive", "required"] as const) {
    if (members.some((m) => m.when[flag]) && !members.every((m) => m.when[flag])) {
      fail(`${ctx} members disagree on ${flag}; every member must declare it`);
    }
  }
}
