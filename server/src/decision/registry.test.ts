import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecisionProjection, DecisionQuestion } from "@argus/contracts";
import { canonicalDigest, CanonicalJsonError } from "./canonical.js";
import { builtinRegistry, RESIDUAL_CAUSE_V1, TERMINATION_PROBE_V1 } from "./definitions.js";
import { RUN_FAILURE_BLIND_V1, RUN_FAILURE_V1 } from "./projections/runFailure.js";
import { createRegistry, RegistryError, type DecisionRegistry } from "./registry.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const PROJECTION: DecisionProjection = {
  id: "test-projection",
  version: 1,
  subject: "run",
  description: "A projection for tests.",
  maxBytes: 1024,
  redactionRules: ["redact.test@1"],
  truncation: { rule: "truncate.code-points@1", caps: { prompt: 10 } },
  withheld: [],
};

const PHASE_PROJECTION: DecisionProjection = {
  ...PROJECTION,
  id: "test-phase-projection",
  subject: "phase-attempt",
};

function question(over: Partial<DecisionQuestion> = {}): DecisionQuestion {
  return {
    id: "test.question",
    version: 1,
    text: "Is this a test?",
    answers: {
      shape: "choice",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      sumTolerance: 0.02,
    },
    subject: "run",
    projection: { id: PROJECTION.id, version: PROJECTION.version },
    consumers: [],
    ...over,
  };
}

function withAnswers(answers: DecisionQuestion["answers"]): DecisionQuestion {
  return question({ answers });
}

function fresh(): DecisionRegistry {
  const r = createRegistry();
  r.registerProjection(PROJECTION);
  r.registerProjection(PHASE_PROJECTION);
  return r;
}

function refusesWith(fn: () => unknown, pattern?: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof RegistryError, `expected RegistryError, got ${String(err)}`);
    assert.equal(err.name, "RegistryError");
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

function optionIds(q: DecisionQuestion): string[] {
  assert.equal(q.answers.shape, "choice");
  return q.answers.shape === "choice" ? q.answers.options.map((o) => o.id) : [];
}

// ── built-ins ────────────────────────────────────────────────────────────────

test("builtinRegistry registers the residual question and the termination probe", () => {
  const r = builtinRegistry();
  const residual = r.question("run.failure-cause.residual", 1);
  const probe = r.question("run.termination-probe", 1);
  assert.ok(residual);
  assert.ok(probe);
  assert.deepEqual(
    r.questions().map((q) => `${q.id}@${q.version}`),
    ["run.failure-cause.residual@1", "run.termination-probe@1"],
  );
  assert.equal(r.latestQuestion("run.failure-cause.residual")?.ref.version, 1);
  assert.equal(r.latestQuestion("run.termination-probe")?.ref.version, 1);
});

test("the built-in questions differ in answer space and projection", () => {
  const r = builtinRegistry();
  const residual = r.question("run.failure-cause.residual", 1)!.def;
  const probe = r.question("run.termination-probe", 1)!.def;
  assert.notDeepEqual(optionIds(residual).sort(), optionIds(probe).sort());
  assert.notDeepEqual(residual.answers, probe.answers);
  assert.equal(residual.projection.id, "run-failure");
  assert.equal(probe.projection.id, "run-failure.blind");
  assert.notEqual(residual.projection.id, probe.projection.id);
  assert.ok(r.projection(residual.projection.id, residual.projection.version));
  assert.ok(r.projection(probe.projection.id, probe.projection.version));
  assert.notEqual(residual.text, probe.text);
});

test("the residual question offers no observed-termination label", () => {
  const ids = optionIds(builtinRegistry().question("run.failure-cause.residual", 1)!.def);
  for (const observed of ["deadline", "never-ran", "ended-normally"]) {
    assert.ok(!ids.includes(observed), `residual options include ${observed}`);
  }
});

test("the termination probe offers every reference label", () => {
  const ids = optionIds(builtinRegistry().question("run.termination-probe", 1)!.def);
  for (const label of [
    "deadline",
    "never-ran",
    "output-refused",
    "rate-limited",
    "permission-denied",
    "ended-normally",
  ]) {
    assert.ok(ids.includes(label), `probe options lack ${label}`);
  }
});

test("both built-in questions have no consumers", () => {
  const r = builtinRegistry();
  assert.deepEqual(r.question("run.failure-cause.residual", 1)!.def.consumers, []);
  assert.deepEqual(r.question("run.termination-probe", 1)!.def.consumers, []);
  assert.deepEqual(RESIDUAL_CAUSE_V1.consumers, []);
  assert.deepEqual(TERMINATION_PROBE_V1.consumers, []);
});

test("built-in refs carry the digest of the definition as declared in code", () => {
  const r = builtinRegistry();
  assert.equal(
    r.question("run.failure-cause.residual", 1)!.ref.digest,
    canonicalDigest(RESIDUAL_CAUSE_V1).sha256,
  );
  assert.equal(
    r.question("run.termination-probe", 1)!.ref.digest,
    canonicalDigest(TERMINATION_PROBE_V1).sha256,
  );
  assert.equal(r.projection("run-failure", 1)!.ref.digest, canonicalDigest(RUN_FAILURE_V1).sha256);
  assert.equal(
    r.projection("run-failure.blind", 1)!.ref.digest,
    canonicalDigest(RUN_FAILURE_BLIND_V1).sha256,
  );
});

test("each builtinRegistry call returns an independent registry", () => {
  const a = builtinRegistry();
  const b = builtinRegistry();
  a.registerQuestion(
    question({
      id: "extra.question",
      projection: { id: RUN_FAILURE_V1.id, version: RUN_FAILURE_V1.version },
    }),
  );
  assert.equal(a.questions().length, 3);
  assert.equal(b.questions().length, 2);
});

// ── consumers ────────────────────────────────────────────────────────────────

test("a question with a non-empty consumers array is refused", () => {
  const r = fresh();
  refusesWith(() => r.registerQuestion(question({ consumers: ["some.policy"] })), /no consumers/);
  assert.equal(r.question("test.question", 1), null);
});

test("a question whose consumers is not an array is refused", () => {
  const r = fresh();
  refusesWith(() => r.registerQuestion(question({ consumers: undefined as unknown as string[] })));
});

// ── idempotence and conflicts ────────────────────────────────────────────────

test("registering the identical definition twice is idempotent and returns the same digest", () => {
  const r = fresh();
  const first = r.registerQuestion(question());
  const second = r.registerQuestion(question());
  assert.deepEqual(second, first);
  assert.equal(first.id, "test.question");
  assert.equal(first.version, 1);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(r.questions().length, 1);
  // key order in the source object does not matter: the digest is canonical
  const reordered = {
    projection: { version: 1, id: PROJECTION.id },
    consumers: [],
    subject: "run",
    answers: question().answers,
    text: "Is this a test?",
    version: 1,
    id: "test.question",
  } as DecisionQuestion;
  assert.deepEqual(r.registerQuestion(reordered), first);
});

test("registering a projection twice is idempotent", () => {
  const r = createRegistry();
  const a = r.registerProjection(PROJECTION);
  const b = r.registerProjection({ ...PROJECTION });
  assert.deepEqual(a, b);
});

test("the same id@version with changed text is refused", () => {
  const r = fresh();
  r.registerQuestion(question());
  refusesWith(
    () => r.registerQuestion(question({ text: "Is this another test?" })),
    /different definition/,
  );
});

test("the same id@version with a changed option label is refused", () => {
  const r = fresh();
  r.registerQuestion(question());
  refusesWith(
    () =>
      r.registerQuestion(
        withAnswers({
          shape: "choice",
          options: [
            { id: "yes", label: "Yes!" },
            { id: "no", label: "No" },
          ],
          sumTolerance: 0.02,
        }),
      ),
    /different definition/,
  );
});

test("the same id@version with a changed sumTolerance is refused", () => {
  const r = fresh();
  r.registerQuestion(question());
  refusesWith(
    () =>
      r.registerQuestion(
        withAnswers({
          shape: "choice",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          sumTolerance: 0.03,
        }),
      ),
    /different definition/,
  );
});

test("the same projection id@version with a changed field is refused", () => {
  const r = createRegistry();
  r.registerProjection(PROJECTION);
  refusesWith(
    () => r.registerProjection({ ...PROJECTION, maxBytes: 2048 }),
    /different definition/,
  );
});

test("a refused re-registration leaves the original in place", () => {
  const r = fresh();
  const ref = r.registerQuestion(question());
  assert.throws(() => r.registerQuestion(question({ text: "changed" })), RegistryError);
  assert.equal(r.question("test.question", 1)!.def.text, "Is this a test?");
  assert.deepEqual(r.question("test.question", 1)!.ref, ref);
});

// ── history ──────────────────────────────────────────────────────────────────

test("historical versions stay registered; latest is the highest version, not the last registered", () => {
  const r = fresh();
  const v2 = question({ version: 2, text: "Is this, really, a test?" });
  const v1 = question({ version: 1 });
  const ref2 = r.registerQuestion(v2);
  const ref1 = r.registerQuestion(v1);

  const got1 = r.question("test.question", 1)!;
  const got2 = r.question("test.question", 2)!;
  assert.equal(got1.def.text, "Is this a test?");
  assert.equal(got2.def.text, "Is this, really, a test?");
  assert.deepEqual(got1.ref, ref1);
  assert.deepEqual(got2.ref, ref2);
  assert.notEqual(ref1.digest, ref2.digest);

  const latest = r.latestQuestion("test.question")!;
  assert.equal(latest.def.version, 2);
  assert.deepEqual(latest.ref, ref2);
});

test("questions() lists every version sorted by id, then version", () => {
  const r = fresh();
  r.registerQuestion(question({ id: "zeta.question", version: 1 }));
  r.registerQuestion(question({ version: 10, text: "ten" }));
  r.registerQuestion(question({ version: 2, text: "two" }));
  r.registerQuestion(question({ id: "alpha.question", version: 3, text: "three" }));
  r.registerQuestion(question({ version: 1 }));
  assert.deepEqual(
    r.questions().map((q) => `${q.id}@${q.version}`),
    [
      "alpha.question@3",
      "test.question@1",
      "test.question@2",
      "test.question@10",
      "zeta.question@1",
    ],
  );
  assert.equal(r.latestQuestion("test.question")!.def.version, 10);
});

test("lookups of unknown ids or versions return null", () => {
  const r = fresh();
  r.registerQuestion(question());
  assert.equal(r.question("test.question", 2), null);
  assert.equal(r.question("nope", 1), null);
  assert.equal(r.latestQuestion("nope"), null);
  assert.equal(r.projection("nope", 1), null);
  assert.equal(r.projection(PROJECTION.id, 9), null);
  assert.deepEqual(createRegistry().questions(), []);
});

// ── immutability ─────────────────────────────────────────────────────────────

test("returned definitions are frozen, deeply", () => {
  const r = fresh();
  r.registerQuestion(question());
  const def = r.question("test.question", 1)!.def;
  assert.ok(Object.isFrozen(def));
  assert.ok(Object.isFrozen(def.answers));
  assert.ok(Object.isFrozen(def.projection));
  assert.ok(Object.isFrozen(def.consumers));
  assert.ok(def.answers.shape === "choice" && Object.isFrozen(def.answers.options));
  assert.ok(def.answers.shape === "choice" && Object.isFrozen(def.answers.options[0]));
  const proj = r.projection(PROJECTION.id, 1)!.def;
  assert.ok(Object.isFrozen(proj));
  assert.ok(Object.isFrozen(proj.truncation.caps));
});

test("mutating a returned definition throws a TypeError and later lookups are unchanged", () => {
  // ES modules are strict mode, so writes to a frozen object throw.
  const r = fresh();
  r.registerQuestion(question());
  const def = r.question("test.question", 1)!.def;
  assert.throws(() => {
    (def as { text: string }).text = "hacked";
  }, TypeError);
  assert.throws(() => {
    (def.consumers as string[]).push("policy");
  }, TypeError);
  assert.throws(() => {
    if (def.answers.shape === "choice") def.answers.options[0].label = "hacked";
  }, TypeError);
  assert.throws(() => {
    delete (def as Partial<DecisionQuestion>).text;
  }, TypeError);
  const again = r.question("test.question", 1)!.def;
  assert.equal(again.text, "Is this a test?");
  assert.deepEqual(again.consumers, []);
  assert.deepEqual(again, question());
  assert.equal(again, def);
});

test("mutating the object passed to registerQuestion afterwards does not change the stored definition", () => {
  const r = fresh();
  const q = question();
  const ref = r.registerQuestion(q);
  q.text = "mutated";
  if (q.answers.shape === "choice") {
    q.answers.options[0].label = "mutated";
    q.answers.options.push({ id: "maybe", label: "Maybe" });
    q.answers.sumTolerance = 0.3;
  }
  q.consumers.push("policy");
  q.projection.id = "elsewhere";

  const stored = r.question("test.question", 1)!;
  assert.deepEqual(stored.def, question());
  assert.deepEqual(stored.ref, ref);
  // re-registering the ORIGINAL definition is still an idempotent no-op...
  assert.deepEqual(r.registerQuestion(question()), ref);
  // ...while the mutated object is now a different definition (and invalid: it has a consumer).
  assert.throws(() => r.registerQuestion(q), RegistryError);
});

test("mutating a projection passed to registerProjection afterwards does not change the stored one", () => {
  const r = createRegistry();
  const p: DecisionProjection = {
    ...PROJECTION,
    truncation: { rule: "x@1", caps: { a: 1 } },
    withheld: [],
  };
  r.registerProjection(p);
  p.truncation.caps.a = 99;
  p.withheld.push("everything");
  const stored = r.projection(PROJECTION.id, 1)!.def;
  assert.equal(stored.truncation.caps.a, 1);
  assert.deepEqual(stored.withheld, []);
});

// ── validation refusals ──────────────────────────────────────────────────────

test("a non-slug question id is refused", () => {
  const r = fresh();
  for (const id of ["", "Bad", "has space", "under_score", "-lead", "trail-", "dou..ble", "ünï"]) {
    refusesWith(() => r.registerQuestion(question({ id })), /not a slug/);
  }
  assert.doesNotThrow(() => r.registerQuestion(question({ id: "a.b-c.d1" })));
});

test("a non-positive-integer version is refused", () => {
  const r = fresh();
  for (const version of [0, 1.5, -1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    refusesWith(() => r.registerQuestion(question({ version })), /positive integer/);
  }
  refusesWith(
    () => r.registerProjection({ ...PROJECTION, id: "p-zero", version: 0 }),
    /positive integer/,
  );
  refusesWith(
    () => r.registerProjection({ ...PROJECTION, id: "p-frac", version: 1.5 }),
    /positive integer/,
  );
  refusesWith(() => r.registerProjection({ ...PROJECTION, id: "Not_Slug" }), /not a slug/);
});

test("empty or whitespace-only text is refused", () => {
  const r = fresh();
  refusesWith(() => r.registerQuestion(question({ text: "" })), /no text/);
  refusesWith(() => r.registerQuestion(question({ text: "   \n" })), /no text/);
  refusesWith(
    () => r.registerQuestion(question({ text: undefined as unknown as string })),
    /no text/,
  );
});

test("a choice space with fewer than two options is refused", () => {
  const r = fresh();
  refusesWith(
    () =>
      r.registerQuestion(
        withAnswers({
          shape: "choice",
          options: [{ id: "only", label: "Only" }],
          sumTolerance: 0.02,
        }),
      ),
    /two or more/,
  );
  refusesWith(
    () => r.registerQuestion(withAnswers({ shape: "choice", options: [], sumTolerance: 0.02 })),
    /two or more/,
  );
});

test("duplicate option ids are refused", () => {
  const r = fresh();
  refusesWith(
    () =>
      r.registerQuestion(
        withAnswers({
          shape: "choice",
          options: [
            { id: "same", label: "One" },
            { id: "same", label: "Two" },
          ],
          sumTolerance: 0.02,
        }),
      ),
    /duplicate/,
  );
});

test("a non-slug option id, or an option without a label, is refused", () => {
  const r = fresh();
  refusesWith(
    () =>
      r.registerQuestion(
        withAnswers({
          shape: "choice",
          options: [
            { id: "Not A Slug", label: "One" },
            { id: "fine", label: "Two" },
          ],
          sumTolerance: 0.02,
        }),
      ),
    /not a slug/,
  );
  refusesWith(
    () =>
      r.registerQuestion(
        withAnswers({
          shape: "choice",
          options: [
            { id: "one", label: "" },
            { id: "two", label: "Two" },
          ],
          sumTolerance: 0.02,
        }),
      ),
    /no label/,
  );
});

test("a scale with a non-finite point is refused; a valid scale is accepted", () => {
  const r = fresh();
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    refusesWith(
      () =>
        r.registerQuestion(
          withAnswers({
            shape: "scale",
            points: [{ value: 1 }, { value: bad }],
            sumTolerance: 0.01,
          }),
        ),
      /not finite/,
    );
  }
  refusesWith(
    () =>
      r.registerQuestion(
        withAnswers({ shape: "scale", points: [{ value: 1 }, { value: 1 }], sumTolerance: 0.01 }),
      ),
    /duplicate/,
  );
  refusesWith(
    () =>
      r.registerQuestion(
        withAnswers({ shape: "scale", points: [{ value: 1 }], sumTolerance: 0.01 }),
      ),
    /two or more/,
  );
  assert.doesNotThrow(() =>
    r.registerQuestion(
      withAnswers({
        shape: "scale",
        points: [{ value: 1, label: "low" }, { value: 2 }, { value: 3 }],
        sumTolerance: 0.01,
      }),
    ),
  );
});

test("a sumTolerance that is negative, >= 0.5 or not finite is refused; the bounds 0 and just under 0.5 are fine", () => {
  const r = fresh();
  const choice = (sumTolerance: number) =>
    withAnswers({
      shape: "choice",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      sumTolerance,
    });
  for (const bad of [-0.001, -1, 0.5, 0.7, 1, Number.NaN, Infinity]) {
    refusesWith(() => r.registerQuestion(choice(bad)), /sumTolerance/);
  }
  refusesWith(
    () =>
      r.registerQuestion(
        withAnswers({ shape: "scale", points: [{ value: 1 }, { value: 2 }], sumTolerance: -0.1 }),
      ),
    /sumTolerance/,
  );
  assert.doesNotThrow(() => r.registerQuestion(choice(0)));
  assert.doesNotThrow(() => r.registerQuestion({ ...choice(0.499), version: 2 }));
});

test("an unknown answer shape is refused", () => {
  const r = fresh();
  refusesWith(
    () =>
      r.registerQuestion(
        withAnswers({ shape: "ranking" } as unknown as DecisionQuestion["answers"]),
      ),
    /unknown answer shape/,
  );
});

test("a binary question is accepted", () => {
  const r = fresh();
  assert.doesNotThrow(() => r.registerQuestion(withAnswers({ shape: "binary" })));
});

test("a question whose projection is not registered is refused", () => {
  const r = fresh();
  refusesWith(
    () => r.registerQuestion(question({ projection: { id: "missing-projection", version: 1 } })),
    /not registered/,
  );
  // the right id at a version that was never registered is also refused
  refusesWith(
    () => r.registerQuestion(question({ projection: { id: PROJECTION.id, version: 2 } })),
    /not registered/,
  );
  assert.equal(r.question("test.question", 1), null);
});

test("a question whose projection reference is malformed is refused", () => {
  const r = fresh();
  refusesWith(
    () => r.registerQuestion(question({ projection: { id: "Bad Id", version: 1 } })),
    /not a slug/,
  );
  refusesWith(
    () => r.registerQuestion(question({ projection: { id: PROJECTION.id, version: 0 } })),
    /positive integer/,
  );
});

test("a question whose subject differs from its projection's subject is refused", () => {
  const r = fresh();
  refusesWith(
    () => r.registerQuestion(question({ subject: "phase-attempt" })),
    /about a phase-attempt, but its projection builds a run/,
  );
  refusesWith(
    () => r.registerQuestion(question({ projection: { id: PHASE_PROJECTION.id, version: 1 } })),
    /about a run, but its projection builds a phase-attempt/,
  );
  assert.doesNotThrow(() =>
    r.registerQuestion(
      question({
        subject: "phase-attempt",
        projection: { id: PHASE_PROJECTION.id, version: 1 },
      }),
    ),
  );
});

test("a projection with an invalid maxBytes is refused", () => {
  const r = createRegistry();
  for (const maxBytes of [0, -1, 1.5, Number.NaN, Infinity]) {
    refusesWith(() => r.registerProjection({ ...PROJECTION, maxBytes }), /maxBytes/);
  }
});

// ── canonical JSON gate ──────────────────────────────────────────────────────

test("an undefined option label is refused rather than registered", () => {
  const r = fresh();
  assert.throws(() =>
    r.registerQuestion(
      withAnswers({
        shape: "choice",
        options: [
          { id: "yes", label: undefined as unknown as string },
          { id: "no", label: "No" },
        ],
        sumTolerance: 0.02,
      }),
    ),
  );
  assert.equal(r.question("test.question", 1), null);
  assert.deepEqual(r.questions(), []);
});

test("a definition holding a value canonical JSON refuses is not registered", () => {
  const r = fresh();
  const bad = { ...question(), note: undefined } as unknown as DecisionQuestion;
  assert.throws(
    () => r.registerQuestion(bad),
    (err: unknown) => {
      assert.ok(err instanceof CanonicalJsonError);
      assert.equal(err.pointer, "/note");
      return true;
    },
  );
  const nan = { ...question(), version: 1, extra: Number.NaN } as unknown as DecisionQuestion;
  assert.throws(() => r.registerQuestion(nan), CanonicalJsonError);
  const date = { ...question(), extra: new Date(0) } as unknown as DecisionQuestion;
  assert.throws(() => r.registerQuestion(date), CanonicalJsonError);
  assert.equal(r.question("test.question", 1), null);
  assert.deepEqual(r.questions(), []);

  assert.throws(
    () =>
      r.registerProjection({
        ...PROJECTION,
        id: "bad-proj",
        withheld: [undefined as unknown as string],
      }),
    CanonicalJsonError,
  );
  assert.equal(r.projection("bad-proj", 1), null);
});

// ── digests ──────────────────────────────────────────────────────────────────

test("a DefinitionRef's digest equals canonicalDigest of the definition as passed", () => {
  const r = fresh();
  const q = question();
  const ref = r.registerQuestion(q);
  assert.equal(ref.digest, canonicalDigest(q).sha256);
  assert.equal(r.question("test.question", 1)!.ref.digest, canonicalDigest(q).sha256);
  // and the frozen stored copy hashes identically to the original
  assert.equal(canonicalDigest(r.question("test.question", 1)!.def).sha256, ref.digest);

  const pref = r.projection(PROJECTION.id, 1)!.ref;
  assert.equal(pref.digest, canonicalDigest(PROJECTION).sha256);
  assert.equal(pref.id, PROJECTION.id);
  assert.equal(pref.version, 1);
});

test("the digest changes with any field of the definition", () => {
  const r = fresh();
  const a = r.registerQuestion(question({ version: 1 }));
  const b = r.registerQuestion(question({ version: 2 }));
  const c = r.registerQuestion(question({ version: 3, text: "Different?" }));
  assert.equal(new Set([a.digest, b.digest, c.digest]).size, 3);
});
