# Outcome-Based Pipeline Routing Design

## Goal

Add generic, data-driven control flow to Argus pipelines. A phase can complete operationally and publish a validated structured result; conditional dependency edges use that result to select work, skip unselected work, and preserve deterministic DAG execution.

## Scope and non-goals

This is workflow-engine infrastructure, not an audit, QA, remediation, deployment, or classification feature. Existing linear and unconditional DAG definitions must retain their exact behavior. This version keeps the graph acyclic. Bounded iteration is a follow-up feature with an explicit loop construct, maximum attempts, and exhaustion route; ordinary conditional edges never introduce cycles.

## Definition model

`PhaseDef.needs` becomes a union of existing string ids and object edges:

```ts
type Dependency =
  | string
  | {
      phase: string;
      when?: RouteCondition;
      allowSkipped?: boolean;
    };

interface RouteCondition {
  group?: string;
  exclusive?: boolean;
  required?: boolean;
  default?: true;
  predicate?: {
    path: string[];
    operator: "equals" | "not-equals" | "one-of" | "exists";
    value?: string | number | boolean | null | Array<string | number | boolean | null>;
  };
}
```

An object edge without `when` is an unconditional dependency. Its default acceptance remains `succeeded` only. `allowSkipped: true` explicitly accepts a selected source that succeeded or an unselected source that was skipped, and is used for joins after alternatives.

A phase can declare an opt-in result:

```ts
result: {
  artifact: "evaluation";
  resultStep?: "evaluate";
  schema: {
    type: "object";
    required: ["decision"];
    properties: {
      decision: { enum: ["approve", "revise", "escalate"] };
    };
  };
}
```

`resultStep` is omitted for a one-step phase and otherwise names the sole step
allowed to publish the phase result.

The schema is a small recursive JSON-value schema: object properties/required fields, scalar types, enums, and array item schemas. It excludes executable expressions, references, custom formats, and arbitrary code. Conditional paths name declared object properties only; array indexing is not supported in this version.

Every conditional edge evaluates the `result` of its immediate source phase. The validator therefore knows both the result schema and every referenced field, and can reject an unknown artifact, missing result declaration, unknown field, unsuitable predicate value, invalid group configuration, duplicate default, dangling dependency, duplicate edge, or cycle before the definition is saved.

## Route selection semantics

When all steps of a phase report operational completion, Argus first validates its declared structured result. It then records the result, publishes it as the named artifact, and evaluates each outgoing conditional edge in deterministic definition order.

- An unconditional edge is satisfied only by `succeeded`, preserving existing behavior.
- A matching conditional edge is selected.
- A nonmatching conditional edge causes its target to become `skipped`, unless that target has another still-unresolved incoming edge; skip propagation continues only after all of its incoming edges are known.
- Ungrouped conditions are additive and can select multiple branches.
- Conditions in the same exclusive group must select at most one branch. Multiple matches fail the source phase with a clear routing failure.
- A `required` group must select at least one branch. A single `default: true` edge in that group is selected only if no ordinary predicate in the group matched.
- A phase starts when every incoming edge is satisfied. A false conditional edge does not satisfy its target; it selects the target for skipping. An `allowSkipped` join edge accepts a skipped dependency so a join after alternatives does not remain pending.

An instance succeeds only when every phase is terminal and every terminal phase is either `succeeded` or intentional `skipped`. A failed or aborted phase still fails/blocks the instance under existing rules.

## Operational outcome versus domain result

Structured results travel through an explicit per-run JSON result file, identified by an engine-provided environment variable and read by the stop hook. The hook sends that parsed JSON in the completion signal. Argus never derives routing values by parsing assistant prose. `ARGUS_OUTCOME` continues to describe operational completion for backward compatibility, but decision-producing prompts instruct the agent to write the result file and complete operationally.

Result delivery is scoped to one declared result-producing step per phase, with an explicit `resultStep` when a phase has more than one step. This prevents concurrent sibling steps from racing to publish a phase-level decision.

Missing or schema-invalid results, malformed result files, and contradictory result submissions fail the phase with a specific routing/result reason. They are operational signal failures and use the existing retry policy. Spawn errors, exits, timeouts, explicit blocked work, and agent failure signals remain operational failures and never select a business branch.

## Persistence, recovery, and human control

`PhaseProgress` and `StepProgress` gain `skipped`. A result-producing `PhaseProgress` stores the validated result separately from its legacy `payload`, so gate answers and existing artifacts remain compatible. The instance stores immutable route-decision records containing the source phase, artifact, structured value, selected edges, skipped edges, and evaluation reason.

`settle()` is the sole route evaluator. It records result and route decisions in the atomic instance write before returning phases to spawn. Recovery only consumes the persisted decision record; it never recomputes a settled decision. Retries/revisions of downstream work do not change an already-settled source route. A gate validates an agent result at completion but activates routes only after approval.

## Observability and UI

The journal adds route-selection, route-skip, and route-failure entries alongside existing phase events. Entries identify the decision phase, evaluated structured value, matching conditions, selected targets, and skipped targets.

The API continues returning definition and persisted instance records, enriched with result and routing state. The Pipeline editor supports unconditional and conditional dependency objects, skip-tolerant join edges, result artifact/schema authoring, default routes, and route groups. Command Center displays a distinct Skipped status, route labels in the graph, and a compact explanation of the result and selected/skipped branches. The user guide and API document the contract and recovery behavior.

## Example

```json
{
  "id": "evaluate",
  "result": {
    "artifact": "evaluation",
    "schema": {
      "type": "object",
      "required": ["accepted"],
      "properties": { "accepted": { "type": "boolean" } }
    }
  }
}
```

`publish` needs `evaluate` with `accepted equals true`; `repair` needs `evaluate` with `accepted equals false`. A later join can need both with `allowSkipped: true`. The same mechanism represents a failing audit verdict as `{ "verdict": "fail" }`: remediation is selected and direct finalization is skipped, while the audit phase itself remains operationally succeeded.
