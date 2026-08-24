import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Authoring validation for outcome routing.
 *
 * Every conditional edge names a result its source phase declares, so the
 * validator can prove — before a definition is saved — that a route can
 * actually be evaluated. The alternative is an instance that starts and then
 * takes a branch nobody can explain, which is the failure mode this whole table
 * exists to make impossible.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-routes-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  return import(`./pipelines.js?${Math.random()}`);
}

const phase = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  cwd: home,
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});

const input = (phases: unknown[]) => ({ name: "P", trigger: null, phases });

/** The spec's worked example: a decision phase with two conditional branches. */
const decisionSchema = {
  type: "object",
  required: ["accepted"],
  properties: { accepted: { type: "boolean" } },
};

const evaluatePhase = (over: Record<string, unknown> = {}) =>
  phase("evaluate", {
    result: { artifact: "evaluation", schema: decisionSchema },
    ...over,
  });

const when = (value: boolean) => ({
  predicate: { path: ["accepted"], operator: "equals", value },
});

// ── A definition with no `when` edges validates exactly as today ─────────────

test("string dependencies still round-trip as plain phase ids", async () => {
  const m = await fresh();
  const out = m.validatePipelineInput(input([phase("plan"), phase("build", { needs: ["plan"] })]));
  assert.deepEqual(out.phases[1].needs, ["plan"]);
  assert.equal(out.phases[1].result, undefined);
});

test("an object edge with no condition is an ordinary dependency", async () => {
  const m = await fresh();
  const out = m.validatePipelineInput(
    input([phase("plan"), phase("build", { needs: [{ phase: "plan" }] })]),
  );
  assert.deepEqual(out.phases[1].needs, [{ phase: "plan" }]);
});

test("the worked example validates and round-trips its routes", async () => {
  const m = await fresh();
  const out = m.validatePipelineInput(
    input([
      evaluatePhase(),
      phase("publish", { needs: [{ phase: "evaluate", when: when(true) }] }),
      phase("repair", { needs: [{ phase: "evaluate", when: when(false) }] }),
      phase("report", {
        needs: [
          { phase: "publish", allowSkipped: true },
          { phase: "repair", allowSkipped: true },
        ],
      }),
    ]),
  );
  assert.deepEqual(out.phases[0].result, {
    artifact: "evaluation",
    schema: decisionSchema,
  });
  assert.deepEqual(out.phases[1].needs, [{ phase: "evaluate", when: when(true) }]);
  assert.deepEqual(out.phases[3].needs, [
    { phase: "publish", allowSkipped: true },
    { phase: "repair", allowSkipped: true },
  ]);
});

test("a group with a default and exclusive members validates", async () => {
  const m = await fresh();
  const group = { group: "verdict", exclusive: true, required: true };
  const out = m.validatePipelineInput(
    input([
      phase("audit", {
        result: {
          artifact: "audit",
          schema: {
            type: "object",
            required: ["verdict"],
            properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
          },
        },
      }),
      phase("ship", {
        needs: [
          {
            phase: "audit",
            when: { ...group, predicate: { path: ["verdict"], operator: "equals", value: "pass" } },
          },
        ],
      }),
      phase("remediate", { needs: [{ phase: "audit", when: { ...group, default: true } }] }),
    ]),
  );
  assert.equal(out.phases[2].needs[0].when.default, true);
});

// ── The rejection table ─────────────────────────────────────────────────────

/** Each case is [label, phases, expected message pattern]. */
const REJECTED: [string, () => unknown[], RegExp][] = [
  [
    "a conditional edge whose source declares no result",
    () => [
      phase("evaluate"),
      phase("publish", { needs: [{ phase: "evaluate", when: when(true) }] }),
    ],
    /phase "publish".*"evaluate" declares no result/,
  ],
  [
    "a predicate path the source schema does not declare",
    () => [
      evaluatePhase(),
      phase("publish", {
        needs: [
          { phase: "evaluate", when: { predicate: { path: ["verdict"], operator: "exists" } } },
        ],
      }),
    ],
    /phase "publish".*path "verdict".*result schema/,
  ],
  [
    "a nested predicate path the schema does not declare",
    () => [
      evaluatePhase(),
      phase("publish", {
        needs: [
          {
            phase: "evaluate",
            when: { predicate: { path: ["accepted", "deep"], operator: "exists" } },
          },
        ],
      }),
    ],
    /phase "publish".*path "accepted.deep"/,
  ],
  [
    "a predicate value the declared type cannot hold",
    () => [
      evaluatePhase(),
      phase("publish", {
        needs: [
          {
            phase: "evaluate",
            when: { predicate: { path: ["accepted"], operator: "equals", value: "yes" } },
          },
        ],
      }),
    ],
    /phase "publish".*value.*boolean/,
  ],
  [
    "a predicate value outside the declared enum",
    () => [
      phase("audit", {
        result: {
          artifact: "audit",
          schema: {
            type: "object",
            properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
          },
        },
      }),
      phase("ship", {
        needs: [
          {
            phase: "audit",
            when: { predicate: { path: ["verdict"], operator: "equals", value: "maybe" } },
          },
        ],
      }),
    ],
    /phase "ship".*enum/,
  ],
  [
    "a one-of predicate whose value is not a list",
    () => [
      evaluatePhase(),
      phase("publish", {
        needs: [
          {
            phase: "evaluate",
            when: { predicate: { path: ["accepted"], operator: "one-of", value: true } },
          },
        ],
      }),
    ],
    /one-of.*list/,
  ],
  [
    "an exists predicate carrying a value",
    () => [
      evaluatePhase(),
      phase("publish", {
        needs: [
          {
            phase: "evaluate",
            when: { predicate: { path: ["accepted"], operator: "exists", value: true } },
          },
        ],
      }),
    ],
    /exists.*no value/,
  ],
  [
    "an unsupported predicate operator",
    () => [
      evaluatePhase(),
      phase("publish", {
        needs: [
          {
            phase: "evaluate",
            when: { predicate: { path: ["accepted"], operator: "matches", value: "x" } },
          },
        ],
      }),
    ],
    /operator must be/,
  ],
  [
    "a condition with neither a predicate nor a default",
    () => [
      evaluatePhase(),
      phase("publish", { needs: [{ phase: "evaluate", when: { group: "g" } }] }),
    ],
    /predicate or default/,
  ],
  [
    "a default route that also carries a predicate",
    () => [
      evaluatePhase(),
      phase("publish", {
        needs: [{ phase: "evaluate", when: { group: "g", default: true, ...when(true) } }],
      }),
    ],
    /default route/,
  ],
  [
    "a default route outside a group",
    () => [
      evaluatePhase(),
      phase("publish", { needs: [{ phase: "evaluate", when: { default: true } }] }),
    ],
    /require a group/,
  ],
  [
    "an exclusive flag outside a group",
    () => [
      evaluatePhase(),
      phase("publish", {
        needs: [{ phase: "evaluate", when: { exclusive: true, ...when(true) } }],
      }),
    ],
    /require a group/,
  ],
  [
    "two defaults in one group",
    () => [
      evaluatePhase(),
      phase("publish", { needs: [{ phase: "evaluate", when: { group: "g", default: true } }] }),
      phase("repair", { needs: [{ phase: "evaluate", when: { group: "g", default: true } }] }),
    ],
    /group "g".*more than one default/,
  ],
  [
    "a group spanning two source phases",
    () => [
      evaluatePhase(),
      phase("second", { result: { artifact: "second", schema: decisionSchema } }),
      phase("publish", { needs: [{ phase: "evaluate", when: { group: "g", ...when(true) } }] }),
      phase("repair", { needs: [{ phase: "second", when: { group: "g", ...when(false) } }] }),
    ],
    /group "g".*more than one source/,
  ],
  [
    "a group whose members disagree on exclusivity",
    () => [
      evaluatePhase(),
      phase("publish", {
        needs: [{ phase: "evaluate", when: { group: "g", exclusive: true, ...when(true) } }],
      }),
      phase("repair", { needs: [{ phase: "evaluate", when: { group: "g", ...when(false) } }] }),
    ],
    /group "g".*exclusive/,
  ],
  [
    "a resultStep naming a step the phase does not have",
    () => [
      phase("evaluate", {
        steps: [
          { name: "a", prompt: "p" },
          { name: "b", prompt: "p" },
        ],
        result: { artifact: "evaluation", resultStep: "ghost", schema: decisionSchema },
      }),
    ],
    /phase "evaluate".*resultStep "ghost"/,
  ],
  [
    "a multi-step result phase with no resultStep",
    () => [
      phase("evaluate", {
        steps: [
          { name: "a", prompt: "p" },
          { name: "b", prompt: "p" },
        ],
        result: { artifact: "evaluation", schema: decisionSchema },
      }),
    ],
    /phase "evaluate".*resultStep.*more than one step/,
  ],
  [
    "a result artifact name that is not a short identifier",
    () => [phase("evaluate", { result: { artifact: "not a name!", schema: decisionSchema } })],
    /phase "evaluate".*artifact/,
  ],
  [
    "a result with no schema",
    () => [phase("evaluate", { result: { artifact: "evaluation" } })],
    /phase "evaluate".*schema/,
  ],
  [
    "a schema type the validator does not implement",
    () => [phase("evaluate", { result: { artifact: "evaluation", schema: { type: "integer" } } })],
    /type must be/,
  ],
  [
    "a schema enum value that its own type cannot hold",
    () => [
      phase("evaluate", {
        result: { artifact: "evaluation", schema: { type: "string", enum: [1] } },
      }),
    ],
    /enum/,
  ],
  [
    "array items declared on a non-array schema",
    () => [
      phase("evaluate", {
        result: {
          artifact: "evaluation",
          schema: { type: "object", items: { type: "string" } },
        },
      }),
    ],
    /items/,
  ],
  [
    "a non-boolean allowSkipped",
    () => [phase("plan"), phase("build", { needs: [{ phase: "plan", allowSkipped: "yes" }] })],
    /allowSkipped/,
  ],
  [
    "a dependency object with no phase id",
    () => [phase("plan"), phase("build", { needs: [{ when: when(true) }] })],
    /phase id/,
  ],
  [
    "a dependency that is neither an id nor an object",
    () => [phase("plan"), phase("build", { needs: [7] })],
    /phase id or a dependency object/,
  ],
];

for (const [label, phases, pattern] of REJECTED) {
  test(`validation rejects ${label}`, async () => {
    const m = await fresh();
    assert.throws(() => m.validatePipelineInput(input(phases())), pattern);
  });
}

// ── The existing DAG checks keep applying through object edges ───────────────

test("a cycle built from object edges is still rejected", async () => {
  const m = await fresh();
  assert.throws(
    () =>
      m.validatePipelineInput(
        input([phase("a", { needs: [{ phase: "b" }] }), phase("b", { needs: [{ phase: "a" }] })]),
      ),
    /cycle/,
  );
});

test("a dangling object edge is still named in the error", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validatePipelineInput(input([phase("a"), phase("b", { needs: [{ phase: "ghost" }] })])),
    /needs "ghost"/,
  );
});

test("the same source listed twice is still a duplicate dependency", async () => {
  const m = await fresh();
  assert.throws(
    () =>
      m.validatePipelineInput(
        input([
          evaluatePhase(),
          phase("publish", {
            needs: [
              { phase: "evaluate", when: when(true) },
              { phase: "evaluate", when: when(false) },
            ],
          }),
        ]),
      ),
    /twice/,
  );
});

test("a patch is validated the same way as a create", async () => {
  const m = await fresh();
  assert.throws(
    () =>
      m.validatePipelinePatch({
        phases: [
          phase("evaluate"),
          phase("publish", { needs: [{ phase: "evaluate", when: when(true) }] }),
        ],
      }),
    /declares no result/,
  );
});
