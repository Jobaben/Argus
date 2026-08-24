import { effectiveEdges } from "../ds";
import type { DependencyEdge, PhaseDef, ResultSchema, RouteCondition } from "../types";

/**
 * Authoring conditional edges and result schemas, as pure functions.
 *
 * Two rules shape all of it. First, the form must never rewrite what it does
 * not understand: a schema or a predicate authored through the API rides along
 * untouched, and the panel says so rather than pretending the field does not
 * exist. Second, an edit must never produce a definition the server will
 * reject — so the group flags are edited *per group* rather than per edge (the
 * server refuses members that disagree), and choosing "otherwise" names a group
 * if none was named, because a default route outside a group is invalid.
 */

/** One property of a result object, as the form edits it. */
export interface EditableField {
  name: string;
  type: "string" | "number" | "boolean";
  /** Allowed values, comma-separated. Empty = any value of the type. */
  values: string;
  required: boolean;
}

const SCALARS = new Set(["string", "number", "boolean"]);

/**
 * The schema as editable fields, or null when it is a shape this form cannot
 * represent — a nested object, an array, a scalar result. Null means "show the
 * badge, keep the schema": losing an author's hand-written schema to a form
 * that could not draw it would be the worst possible outcome.
 */
export function schemaFields(schema: ResultSchema | undefined): EditableField[] | null {
  if (!schema) return [];
  if (schema.type !== "object" || schema.items || schema.enum) return null;
  const required = new Set(schema.required ?? []);
  const fields: EditableField[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (!SCALARS.has(property.type) || property.properties || property.items) return null;
    fields.push({
      name,
      type: property.type as EditableField["type"],
      values: (property.enum ?? []).map((v) => String(v)).join(", "),
      required: required.has(name),
    });
  }
  // A `required` entry with no property declared is a schema the form would
  // silently drop on save.
  if ([...required].some((name) => !fields.some((f) => f.name === name))) return null;
  return fields;
}

/** Split a comma-separated allowed-values list into typed scalars. */
export function parseValues(field: EditableField): Array<string | number | boolean> {
  return field.values
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "")
    .map((v) => parseValue(field.type, v));
}

/** One typed scalar from the text an input holds. */
export function parseValue(type: EditableField["type"], raw: string): string | number | boolean {
  if (type === "boolean") return raw === "true";
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return raw;
}

/** The fields as the schema the server validates results against. */
export function fieldsToSchema(fields: EditableField[]): ResultSchema {
  const named = fields.filter((f) => f.name.trim() !== "");
  const properties: Record<string, ResultSchema> = {};
  for (const field of named) {
    const values = parseValues(field);
    properties[field.name.trim()] = {
      type: field.type,
      ...(values.length > 0 ? { enum: values } : {}),
    };
  }
  const required = named.filter((f) => f.required).map((f) => f.name.trim());
  return {
    type: "object",
    ...(required.length > 0 ? { required } : {}),
    properties,
  };
}

/** The edge from `source` into `target`, in whatever form it is declared. */
export function edgeBetween(
  phases: PhaseDef[],
  targetId: string,
  sourceId: string,
): DependencyEdge | null {
  const edges = effectiveEdges(phases).get(targetId) ?? [];
  return edges.find((e) => e.phase === sourceId) ?? null;
}

/**
 * Replace one edge, materializing the implicit linear edges first.
 *
 * The materialization is the same move the "starts after" toggles make: a
 * pipeline with no `needs` anywhere means "linear", so writing one explicit
 * edge has to write them all or the graph reshapes itself under the author.
 */
export function withEdge(phases: PhaseDef[], targetId: string, edge: DependencyEdge): PhaseDef[] {
  const effective = effectiveEdges(phases);
  return phases.map((p) => {
    const current = effective.get(p.id) ?? [];
    if (p.id !== targetId) return { ...p, needs: current };
    return {
      ...p,
      needs: current.map((e) => (e.phase === edge.phase ? edge : e)),
    };
  });
}

/**
 * Set a flag on every member of a route group.
 *
 * Per group, not per edge: the members live on different phases, and the server
 * rejects a group whose members disagree about being exclusive or required.
 * Editing one member's flag alone would author a guaranteed 400.
 */
export function withGroupFlag(
  phases: PhaseDef[],
  group: string,
  flag: "exclusive" | "required",
  on: boolean,
): PhaseDef[] {
  const effective = effectiveEdges(phases);
  return phases.map((p) => ({
    ...p,
    needs: (effective.get(p.id) ?? []).map((edge) => {
      if (edge.when?.group !== group) return edge;
      const when: RouteCondition = { ...edge.when };
      if (on) when[flag] = true;
      else delete when[flag];
      return { ...edge, when };
    }),
  }));
}

/**
 * A name for a newly added field.
 *
 * Added *named*, not blank: the fields are derived from the schema on every
 * render, and a schema cannot hold a property with no name — so a blank new row
 * would vanish the moment it appeared. The author renames it; the row stays.
 */
export function freshFieldName(fields: EditableField[]): string {
  const taken = new Set(fields.map((f) => f.name.trim()));
  if (!taken.has("field")) return "field";
  for (let n = 2; ; n++) if (!taken.has(`field${n}`)) return `field${n}`;
}

/** Every group name already in use, so the panel can offer them. */
export function groupNames(phases: PhaseDef[]): string[] {
  const names = new Set<string>();
  for (const edges of effectiveEdges(phases).values()) {
    for (const edge of edges) if (edge.when?.group) names.add(edge.when.group);
  }
  return [...names].sort();
}
