import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Claim, KnowledgeScope } from "@argus/contracts";
import {
  ALSO_READ_MAX,
  LOCAL_CLAIM_ID_MAX,
  claimIdInScopes,
  claimsInScopes,
  knowledgeScopePolicyFor,
  localClaimId,
  normalizeRemoteRepositoryId,
  parseKnowledgeScopePolicy,
  qualifyClaimId,
  readableScopes,
  resolveKnowledgeScope,
  resolveRepositoryId,
  sameScope,
  scopeKey,
  scopeToken,
  sliceOfScope,
} from "./scope.js";
import { CLAIM_ID_RE, KnowledgeValidationError } from "./kernel.js";

const A: KnowledgeScope = { projectId: "motorit", repositoryId: "git:github.com/motorit/online" };
const B: KnowledgeScope = { projectId: "acme", repositoryId: "git:github.com/acme/kobra" };

// ── Identity ────────────────────────────────────────────────────────────────

test("a scope key and token are deterministic, and different scopes never share them", () => {
  assert.equal(scopeKey(A), "motorit/git:github.com/motorit/online");
  assert.equal(scopeToken(A), scopeToken({ ...A }));
  assert.notEqual(scopeToken(A), scopeToken(B));
  // Same repository, different project: a different scope, not the same one.
  assert.notEqual(scopeToken(A), scopeToken({ ...A, projectId: "other" }));
});

test("sameScope never lets an unscoped record pass for a scoped one", () => {
  assert.equal(sameScope(A, { ...A }), true);
  assert.equal(sameScope(A, B), false);
  assert.equal(sameScope(undefined, undefined), true);
  assert.equal(sameScope(A, undefined), false);
  assert.equal(sameScope(undefined, A), false);
});

test("RULE-42 in two scopes yields two distinct, still-valid canonical ids", () => {
  const a = qualifyClaimId("RULE-42", A);
  const b = qualifyClaimId("RULE-42", B);
  assert.notEqual(a, b);
  assert.match(a, /^RULE-42\.[0-9a-f]{8}$/);
  assert.ok(CLAIM_ID_RE.test(a) && CLAIM_ID_RE.test(b));
  assert.equal(localClaimId(a, A), "RULE-42");
  // …and neither can be read as the other's, nor as the unscoped one.
  assert.equal(localClaimId(a, B), a);
  assert.equal(qualifyClaimId("RULE-42", undefined), "RULE-42");
});

test("a local id too long to carry its scope suffix is refused, not truncated", () => {
  const ok = "R".repeat(LOCAL_CLAIM_ID_MAX);
  assert.ok(CLAIM_ID_RE.test(qualifyClaimId(ok, A)));
  assert.throws(
    () => qualifyClaimId("R".repeat(LOCAL_CLAIM_ID_MAX + 1), A),
    KnowledgeValidationError,
  );
});

// ── The scope index ─────────────────────────────────────────────────────────

const claim = (id: string, scope?: KnowledgeScope): Claim => ({
  id,
  revision: 1,
  ...(scope ? { scope } : {}),
  kind: "business-rule",
  statement: id,
  createdAt: "t",
});

function ledgerOf(claims: Claim[]) {
  return {
    claims,
    evidence: [
      {
        id: "EV-a",
        claim: { id: claims[0].id, revision: 1 },
        direction: "supports" as const,
        source: { type: "human" as const, who: "t" },
        createdAt: "t",
      },
    ],
    justifications: [],
  };
}

test("the scope index keys claims by scope, and unscoped records are their own bucket", () => {
  const led = ledgerOf([claim("RULE-1.aaa", A), claim("RULE-2.bbb", B), claim("RULE-3")]);
  assert.deepEqual(
    sliceOfScope(led, A).claims.map((c) => c.id),
    ["RULE-1.aaa"],
  );
  assert.deepEqual(
    sliceOfScope(led, B).claims.map((c) => c.id),
    ["RULE-2.bbb"],
  );
  // Unscoped is a scope of its own: asking for it never returns scoped claims,
  // and asking for a scope never returns the legacy ones.
  assert.deepEqual(
    sliceOfScope(led, undefined).claims.map((c) => c.id),
    ["RULE-3"],
  );
  // An unknown scope is empty, never "everything".
  assert.deepEqual(
    sliceOfScope(led, { projectId: "nope", repositoryId: "git:x.com/y" }).claims,
    [],
  );
});

test("the index is memoized per snapshot, so scope is a keyed lookup and not a scan", () => {
  const led = ledgerOf([claim("RULE-1.aaa", A)]);
  assert.equal(sliceOfScope(led, A), sliceOfScope(led, A));
  // A different snapshot object gets its own index rather than a stale one.
  const next = ledgerOf([claim("RULE-1.aaa", A), claim("RULE-9.aaa", A)]);
  assert.equal(sliceOfScope(next, A).claims.length, 2);
  assert.equal(sliceOfScope(led, A).claims.length, 1);
});

test("evidence is sliced by the scope of the claim it is about", () => {
  const led = ledgerOf([claim("RULE-1.aaa", A), claim("RULE-2.bbb", B)]);
  assert.deepEqual(
    sliceOfScope(led, A).evidence.map((e) => e.id),
    ["EV-a"],
  );
  assert.deepEqual(sliceOfScope(led, B).evidence, []);
});

test("claimsInScopes unions explicitly named scopes and nothing else", () => {
  const led = ledgerOf([claim("RULE-1.aaa", A), claim("RULE-2.bbb", B), claim("RULE-3")]);
  assert.deepEqual(
    claimsInScopes(led, [A, B]).map((c) => c.id),
    ["RULE-1.aaa", "RULE-2.bbb"],
  );
  assert.equal(claimIdInScopes(led, "RULE-2.bbb", [A]), false);
  assert.equal(claimIdInScopes(led, "RULE-2.bbb", [A, B]), true);
  assert.equal(claimIdInScopes(led, "RULE-3", [A, B]), false);
});

// ── Authoring ───────────────────────────────────────────────────────────────

test("a scope policy is validated, and a filesystem path is never a repository id", () => {
  assert.deepEqual(parseKnowledgeScopePolicy({ projectId: "motorit" }), {
    projectId: "motorit",
  });
  assert.deepEqual(
    parseKnowledgeScopePolicy({ projectId: "motorit", repositoryId: "git:github.com/m/o" }),
    { projectId: "motorit", repositoryId: "git:github.com/m/o" },
  );
  for (const bad of [
    {},
    { projectId: "" },
    { projectId: "has space" },
    { projectId: "ok", repositoryId: "C:\\src\\MotoritOnline" },
    { projectId: "ok", repositoryId: "/home/user/src/MotoritOnline" },
    { projectId: "ok", nope: 1 },
  ]) {
    assert.throws(
      () => parseKnowledgeScopePolicy(bad),
      KnowledgeValidationError,
      JSON.stringify(bad),
    );
  }
});

test("alsoRead must be fully specified, deduplicated and bounded", () => {
  const policy = parseKnowledgeScopePolicy({ projectId: "a", alsoRead: [B] });
  assert.deepEqual(policy.alsoRead, [B]);
  // Half a scope is a different scope, not a broader one.
  assert.throws(
    () => parseKnowledgeScopePolicy({ projectId: "a", alsoRead: [{ projectId: "b" }] }),
    KnowledgeValidationError,
  );
  assert.throws(
    () => parseKnowledgeScopePolicy({ projectId: "a", alsoRead: [B, { ...B }] }),
    /twice/,
  );
  assert.throws(
    () =>
      parseKnowledgeScopePolicy({
        projectId: "a",
        alsoRead: Array.from({ length: ALSO_READ_MAX + 1 }, (_, i) => ({
          projectId: `p${i}`,
          repositoryId: "git:github.com/x/y",
        })),
      }),
    /at most/,
  );
});

test("a phase's scope policy replaces the pipeline's rather than merging with it", () => {
  const pipeline = { knowledgeScope: { projectId: "a", alsoRead: [B] } };
  assert.deepEqual(knowledgeScopePolicyFor(pipeline, undefined), pipeline.knowledgeScope);
  assert.deepEqual(knowledgeScopePolicyFor(pipeline, { knowledgeScope: { projectId: "b" } }), {
    projectId: "b",
  });
  assert.equal(knowledgeScopePolicyFor({}, undefined), undefined);
});

test("readableScopes puts the run's own scope first, so an unqualified id is always its own", () => {
  assert.deepEqual(readableScopes({ scope: A, alsoRead: [B] }), [A, B]);
  assert.deepEqual(readableScopes({}), [undefined]);
});

// ── Repository identity ─────────────────────────────────────────────────────

test("every spelling of one remote normalizes to one repository identity", () => {
  const want = "git:github.com/acme/kobra";
  for (const url of [
    "https://github.com/Acme/Kobra.git",
    "https://github.com/Acme/Kobra",
    "git@github.com:Acme/Kobra.git",
    "ssh://git@github.com/Acme/Kobra.git",
    "ssh://git@github.com:22/Acme/Kobra",
    "https://someone@github.com/Acme/Kobra.git",
    "  https://github.com/Acme/Kobra.git/  ",
  ]) {
    assert.equal(normalizeRemoteRepositoryId(url), want, url);
  }
  assert.notEqual(normalizeRemoteRepositoryId("https://github.com/acme/other.git"), want);
});

test("a path-shaped remote is refused rather than becoming identity", () => {
  for (const url of [
    "/srv/git/kobra.git",
    "C:\\mirrors\\kobra",
    "file:///srv/git/kobra.git",
    "",
    "github.com",
    "https://github.com/",
  ]) {
    assert.equal(normalizeRemoteRepositoryId(url), null, url);
  }
});

// ── Against a real repository ───────────────────────────────────────────────

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
}

const git = (dir: string, args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], {
    cwd: dir,
    encoding: "utf8",
  });

/** A repository with its own first commit. `content` varies so two calls make
 *  two genuinely unrelated histories — a shared root commit would mean a
 *  shared history, which is exactly what the derivation is entitled to say. */
let repoSeq = 0;
async function repo(remote?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-scope-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(dir, "a.txt"), `repository ${(repoSeq += 1)}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", `one ${repoSeq}`]);
  if (remote) git(dir, ["remote", "add", "origin", remote]);
  return dir;
}

test(
  "a worktree and a second clone of one repository resolve to the same identity",
  { skip: gitAvailable() ? false : "git is not available" },
  async () => {
    const origin = await repo("https://github.com/Acme/Kobra.git");
    const expected = "git:github.com/acme/kobra";
    assert.equal(await resolveRepositoryId(origin), expected);

    // A git worktree: a different path, the same logical repository.
    const trees = await mkdtemp(path.join(tmpdir(), "argus-scope-wt-"));
    const worktree = path.join(trees, "ruleset-poc");
    assert.equal(git(origin, ["worktree", "add", "-q", worktree, "-b", "poc"]).status, 0);
    assert.equal(await resolveRepositoryId(worktree), expected);

    // A second clone, on another "machine": different path, same identity —
    // and spelled with the SCP form, which must normalize to the same answer.
    const clone = await mkdtemp(path.join(tmpdir(), "argus-scope-clone-"));
    const target = path.join(clone, "MotoritOnline");
    assert.equal(git(clone, ["clone", "-q", origin, target]).status, 0);
    git(target, ["remote", "set-url", "origin", "git@github.com:Acme/Kobra.git"]);
    assert.equal(await resolveRepositoryId(target), expected);

    // An unrelated repository is never the same identity.
    const other = await repo("https://github.com/Acme/Other.git");
    assert.notEqual(await resolveRepositoryId(other), expected);
  },
);

test(
  "with no remote, the root commit identifies the repository — and clones agree",
  { skip: gitAvailable() ? false : "git is not available" },
  async () => {
    const origin = await repo();
    const id = await resolveRepositoryId(origin);
    assert.match(String(id), /^commit:[0-9a-f]{40}$/);

    const clone = await mkdtemp(path.join(tmpdir(), "argus-scope-clone2-"));
    const target = path.join(clone, "copy");
    assert.equal(git(clone, ["clone", "-q", origin, target]).status, 0);
    // The clone has an `origin` — a local path, which is refused as identity —
    // so it falls through to the root commit and agrees with the original.
    assert.equal(await resolveRepositoryId(target), id);

    // A different repository has a different root commit.
    assert.notEqual(await resolveRepositoryId(await repo()), id);
  },
);

test(
  "a directory that is not a repository yields no identity, and refuses the launch",
  { skip: gitAvailable() ? false : "git is not available" },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "argus-scope-plain-"));
    assert.equal(await resolveRepositoryId(dir), null);
    const refused = await resolveKnowledgeScope({ projectId: "motorit" }, dir);
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /Declare knowledgeScope\.repositoryId/);
    // Never the directory name.
    assert.doesNotMatch(refused.ok ? "" : refused.reason.replace(dir, ""), /argus-scope-plain/);

    // A declared repository id needs no working tree at all.
    const declared = await resolveKnowledgeScope(
      { projectId: "motorit", repositoryId: "git:github.com/m/o" },
      dir,
    );
    assert.equal(declared.ok, true);
    assert.deepEqual(declared.ok && declared.resolved.scope, {
      projectId: "motorit",
      repositoryId: "git:github.com/m/o",
    });
  },
);

test("an alsoRead entry equal to the run's own scope is dropped, not duplicated", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-scope-self-"));
  const r = await resolveKnowledgeScope(
    { projectId: A.projectId, repositoryId: A.repositoryId, alsoRead: [{ ...A }, B] },
    dir,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.resolved.alsoRead, [B]);
});
