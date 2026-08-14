import type { Dependency, DependencyEdge, ResultSchema, RoutePredicate } from "./pipelineTypes.js";

export class ResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultValidationError";
  }
}

export class RouteEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteEvaluationError";
  }
}

/** Converts legacy string dependencies into the single object edge model. */
export function normalizeNeeds(needs: Dependency[] | undefined): DependencyEdge[] {
  return (needs ?? []).map((dependency) =>
    typeof dependency === "string" ? { phase: dependency } : dependency,
  );
}

/** Returns the input value after proving it conforms to the declared schema. */
export function validateResult(schema: ResultSchema, value: unknown): unknown {
  validateValue(schema, value, "result");
  return value;
}

function validateValue(schema: ResultSchema, value: unknown, path: string): void {
  if (!matchesType(schema.type, value)) {
    throw new ResultValidationError(`${path} must be a ${schema.type}`);
  }

  if (schema.enum && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    throw new ResultValidationError(`${path} must be one of the declared enum values`);
  }

  if (schema.type === "object") {
    const object = value as Record<string, unknown>;
    for (const property of schema.required ?? []) {
      if (!Object.hasOwn(object, property)) {
        throw new ResultValidationError(`${path}.${property} is required`);
      }
    }
    for (const [property, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(object, property)) {
        validateValue(propertySchema, object[property], `${path}.${property}`);
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    (value as unknown[]).forEach((item, index) =>
      validateValue(schema.items!, item, `${path}[${index}]`),
    );
  }
}

function matchesType(type: ResultSchema["type"], value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

/** Evaluates one supported predicate against a JSON result object. */
export function evaluatePredicate(result: unknown, predicate: RoutePredicate): boolean {
  const resolved = resolvePath(result, predicate.path);
  if (predicate.operator === "exists") return resolved.found;

  switch (predicate.operator) {
    case "equals":
      return resolved.found && Object.is(resolved.value, predicate.value);
    case "not-equals":
      return resolved.found && !Object.is(resolved.value, predicate.value);
    case "one-of":
      return (
        resolved.found &&
        Array.isArray(predicate.value) &&
        predicate.value.some((candidate) => Object.is(candidate, resolved.value))
      );
    default:
      throw new RouteEvaluationError(`unsupported route predicate operator: ${predicate.operator}`);
  }
}

function resolvePath(value: unknown, path: string[]): { found: boolean; value: unknown } {
  let current = value;
  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/**
 * Selects and skips outgoing edges in declaration order. Definition validation
 * owns malformed route configuration; this pure evaluator enforces runtime
 * selection failures that could otherwise create ambiguous work.
 */
export function evaluateRoutes(
  dependencies: Dependency[],
  result: unknown,
): { selected: string[]; skipped: string[] } {
  const edges = normalizeNeeds(dependencies);
  const selected = new Set<string>();
  const groups = new Map<string, DependencyEdge[]>();

  for (const edge of edges) {
    if (!edge.when) {
      selected.add(edge.phase);
    } else if (edge.when.group) {
      const group = groups.get(edge.when.group) ?? [];
      group.push(edge);
      groups.set(edge.when.group, group);
    } else if (
      !edge.when.default &&
      edge.when.predicate &&
      evaluatePredicate(result, edge.when.predicate)
    ) {
      selected.add(edge.phase);
    }
  }

  for (const [groupName, groupEdges] of groups) {
    const ordinaryMatches = groupEdges.filter(
      (edge) =>
        !edge.when!.default &&
        edge.when!.predicate &&
        evaluatePredicate(result, edge.when!.predicate),
    );
    const defaults = groupEdges.filter((edge) => edge.when!.default);
    const groupSelected = ordinaryMatches.length > 0 ? ordinaryMatches : defaults;
    const exclusive = groupEdges.some((edge) => edge.when!.exclusive);
    const required = groupEdges.some((edge) => edge.when!.required);

    if (exclusive && groupSelected.length > 1) {
      throw new RouteEvaluationError(
        `exclusive route group "${groupName}" matched more than one route`,
      );
    }
    if (required && groupSelected.length === 0) {
      throw new RouteEvaluationError(`required route group "${groupName}" did not match a route`);
    }
    for (const edge of groupSelected) selected.add(edge.phase);
  }

  return {
    selected: edges.filter((edge) => selected.has(edge.phase)).map((edge) => edge.phase),
    skipped: edges.filter((edge) => !selected.has(edge.phase)).map((edge) => edge.phase),
  };
}
