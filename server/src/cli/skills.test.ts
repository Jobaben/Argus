/**
 * `argus skills` against throwaway agent homes and a stand-in build: what a
 * fresh install writes, how an update tells an older copy from an edited one,
 * and that nothing a person wrote is lost on the way. The last block checks
 * the skills this repository actually ships.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  argusRoot,
  bundledSkillDir,
  installSkills,
  installedSkillDir,
  resolveSkillTargets,
  runSkills,
  skillBackupRoot,
  skillStatuses,
  staleSkillsNotice,
  type SkillsIo,
} from "./skills.js";
import {
  BUNDLED_SKILLS,
  MANIFEST_FILE,
  ROOT_PLACEHOLDER,
  classify,
  parseSkillsArgs,
} from "./skillsCore.js";

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A build with both skills, the pipeline one naming its root. */
function fakeBuild(): string {
  const root = mkdtempSync(path.join(tmpdir(), "argus-skill-build-"));
  write(
    path.join(root, ".claude", "skills", "argus-pipeline", "SKILL.md"),
    `---\nname: argus-pipeline\ndescription: d\n---\nDocs: ${ROOT_PLACEHOLDER}/docs\n`,
  );
  write(path.join(root, ".claude", "skills", "argus-pipeline", "reference", "a.md"), "A\n");
  write(
    path.join(root, ".claude", "skills", "argus-tail", "SKILL.md"),
    "---\nname: argus-tail\ndescription: t\n---\n",
  );
  return root;
}

/** Fresh Claude and Codex homes for one test; restores the env afterwards. */
async function withHomes(
  fn: (homes: { claude: string; codex: string }) => Promise<void>,
): Promise<void> {
  const homes = {
    claude: mkdtempSync(path.join(tmpdir(), "argus-skills-claude-")),
    codex: mkdtempSync(path.join(tmpdir(), "argus-skills-codex-")),
  };
  const prev = { claude: process.env.ARGUS_CLAUDE_HOME, codex: process.env.ARGUS_CODEX_HOME };
  process.env.ARGUS_CLAUDE_HOME = homes.claude;
  process.env.ARGUS_CODEX_HOME = homes.codex;
  try {
    await fn(homes);
  } finally {
    for (const [key, value] of [
      ["ARGUS_CLAUDE_HOME", prev.claude],
      ["ARGUS_CODEX_HOME", prev.codex],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function io(over: Partial<SkillsIo> = {}): SkillsIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    probe: () => false,
    now: () => new Date("2026-10-22T10:00:00.000Z"),
    lines,
    errors,
    ...over,
  };
}

const pipelineSkill = (home: string) => path.join(home, "skills", "argus-pipeline");

describe("argus skills install", () => {
  it("installs every skill with the build's path in place of the placeholder", async () => {
    await withHomes(async (homes) => {
      const root = fakeBuild();
      const o = io({ root });
      const results = await installSkills(BUNDLED_SKILLS, "claude", o);
      assert.deepEqual(
        results.map((r) => [r.skill, r.action]),
        [
          ["argus-pipeline", "installed"],
          ["argus-tail", "installed"],
        ],
      );
      const dir = pipelineSkill(homes.claude);
      assert.equal(
        readFileSync(path.join(dir, "SKILL.md"), "utf8"),
        `---\nname: argus-pipeline\ndescription: d\n---\nDocs: ${root.replace(/\\/g, "/")}/docs\n`,
      );
      assert.equal(readFileSync(path.join(dir, "reference", "a.md"), "utf8"), "A\n");
      const manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), "utf8"));
      assert.equal(manifest.skill, "argus-pipeline");
      assert.equal(manifest.argusRoot, root);
      assert.equal(
        existsSync(path.join(homes.claude, "skills", ".argus-pipeline.argus-staging")),
        false,
      );
      assert.equal(existsSync(pipelineSkill(homes.codex)), false, "codex was not asked for");

      const again = await installSkills(BUNDLED_SKILLS, "claude", io({ root }));
      assert.deepEqual(
        again.map((r) => r.action),
        ["unchanged", "unchanged"],
      );
    });
  });

  it("replaces an older copy whole — a file the new one dropped does not linger", async () => {
    await withHomes(async (homes) => {
      const root = fakeBuild();
      write(path.join(bundledSkillDir("argus-pipeline", root), "reference", "old.md"), "old\n");
      await installSkills(["argus-pipeline"], "claude", io({ root }));
      // The next build drops old.md and changes SKILL.md.
      const next = fakeBuild();
      write(
        path.join(bundledSkillDir("argus-pipeline", next), "SKILL.md"),
        "---\nname: argus-pipeline\ndescription: v2\n---\n",
      );

      const [before] = (await skillStatuses(["argus-pipeline"], next)).filter(
        (s) => s.runtime === "claude",
      );
      assert.equal(before.state, "outdated");

      const [r] = await installSkills(["argus-pipeline"], "claude", io({ root: next }));
      assert.equal(r.action, "updated");
      assert.equal(r.backup, undefined, "an untouched older copy is not worth keeping");
      const dir = pipelineSkill(homes.claude);
      assert.match(readFileSync(path.join(dir, "SKILL.md"), "utf8"), /description: v2/);
      assert.equal(existsSync(path.join(dir, "reference", "old.md")), false);
      assert.equal(existsSync(skillBackupRoot()), false);
    });
  });

  it("saves an edited copy before replacing it", async () => {
    await withHomes(async (homes) => {
      const root = fakeBuild();
      await installSkills(["argus-pipeline"], "claude", io({ root }));
      const dir = pipelineSkill(homes.claude);
      writeFileSync(path.join(dir, "SKILL.md"), "my own notes\n");
      write(
        path.join(bundledSkillDir("argus-pipeline", root), "SKILL.md"),
        "---\nname: argus-pipeline\ndescription: v2\n---\n",
      );

      const [status] = (await skillStatuses(["argus-pipeline"], root)).filter(
        (s) => s.runtime === "claude",
      );
      assert.equal(status.state, "modified");

      const o = io({ root });
      const [r] = await installSkills(["argus-pipeline"], "claude", o);
      assert.equal(r.action, "updated");
      assert.ok(r.backup?.startsWith(path.join(skillBackupRoot(), "claude")), String(r.backup));
      assert.equal(readFileSync(path.join(r.backup!, "SKILL.md"), "utf8"), "my own notes\n");
      assert.match(readFileSync(path.join(dir, "SKILL.md"), "utf8"), /description: v2/);
    });
  });

  it("replaces a hand-installed old skill, keeping it first, and adopts an identical one", async () => {
    await withHomes(async (homes) => {
      const root = fakeBuild();
      // What users have today: a folder of their own, with a helper script and no manifest.
      const old = pipelineSkill(homes.codex);
      write(path.join(old, "SKILL.md"), "old skill\n");
      write(path.join(old, "argus-pipeline.mjs"), "// old helper\n");

      const o = io({ root, probe: () => false });
      const results = await installSkills(["argus-pipeline", "argus-tail"], "auto", o);
      // Codex's CLI is not on PATH, but its home already had the skill: an
      // update reaches it. Claude Code had neither, so it is left alone.
      assert.deepEqual(
        results.map((r) => [r.skill, r.runtime, r.action, r.was]),
        [
          ["argus-pipeline", "codex", "updated", "unmanaged"],
          ["argus-tail", "codex", "installed", "missing"],
        ],
      );
      assert.equal(existsSync(path.join(old, "argus-pipeline.mjs")), false);
      assert.equal(
        readFileSync(path.join(results[0].backup!, "argus-pipeline.mjs"), "utf8"),
        "// old helper\n",
      );
      assert.equal(existsSync(pipelineSkill(homes.claude)), false);

      // A copy identical to the bundled one, made by hand: nothing to replace,
      // but it gains a manifest, so a later edit to it shows as one.
      const tail = path.join(homes.claude, "skills", "argus-tail");
      write(
        path.join(tail, "SKILL.md"),
        readFileSync(path.join(bundledSkillDir("argus-tail", root), "SKILL.md"), "utf8"),
      );
      const [adopted] = await installSkills(["argus-tail"], "claude", io({ root }));
      assert.equal(adopted.action, "unchanged");
      assert.equal(existsSync(path.join(tail, MANIFEST_FILE)), true);
    });
  });

  it("prints what it did, how to invoke each skill, and what it skipped", async () => {
    await withHomes(async () => {
      const root = fakeBuild();
      const o = io({ root, probe: (rt) => rt === "claude" });
      assert.equal(await runSkills(["install", "argus-pipeline"], o), 0);
      assert.match(
        o.lines[0],
        /^\[argus skills\] installed the argus-pipeline skill for Claude Code at .*SKILL\.md$/,
      );
      assert.match(
        o.lines[1],
        /invoke argus-pipeline by name with \/argus-pipeline in Claude Code/,
      );
      assert.match(o.lines[2], /skipped Codex \(CLI not found on PATH\)/);

      const status = io({ root });
      assert.equal(await runSkills(["--json"], status), 0);
      const rows = status.lines.map(
        (l) => JSON.parse(l) as { skill: string; runtime: string; state: string },
      );
      assert.deepEqual(
        rows.map((r) => `${r.skill}/${r.runtime}/${r.state}`),
        [
          "argus-pipeline/claude/current",
          "argus-pipeline/codex/missing",
          "argus-tail/claude/missing",
          "argus-tail/codex/missing",
        ],
      );
    });
  });

  it("refuses unknown skills, targets and commands with exit 2", async () => {
    for (const argv of [
      ["install", "nope"],
      ["install", "--for=qwen"],
      ["frobnicate"],
      ["status", "argus-tail"],
    ]) {
      const o = io();
      assert.equal(await runSkills(argv, o), 2, argv.join(" "));
      assert.equal(o.errors.length, 1);
    }
  });
});

describe("skills core", () => {
  it("parses commands, names and --for in both spellings", () => {
    const bare = parseSkillsArgs([]);
    assert.equal(bare.kind === "run" && bare.options.command, "status");
    const update = parseSkillsArgs(["update", "argus-pipeline", "--for", "codex"]);
    assert.ok(update.kind === "run");
    if (update.kind === "run") {
      assert.equal(update.options.command, "install", "update is install");
      assert.deepEqual(update.options.skills, ["argus-pipeline"]);
      assert.equal(update.options.target, "codex");
    }
    const all = parseSkillsArgs(["install", "--for=ALL"]);
    assert.ok(
      all.kind === "run" &&
        all.options.target === "all" &&
        all.options.skills.length === BUNDLED_SKILLS.length,
    );
    assert.equal(parseSkillsArgs(["install", "--for"]).kind, "error");
  });

  it("classifies by digest: identical, untouched, edited, foreign", () => {
    const m = (digest: string) => ({
      skill: "s",
      digest,
      argusVersion: "1",
      argusRoot: "/r",
      installedAt: "t",
    });
    assert.equal(classify("b", null), "missing");
    assert.equal(classify("b", { digest: "b", manifest: null }), "current");
    assert.equal(classify("b", { digest: "a", manifest: m("a") }), "outdated");
    assert.equal(classify("b", { digest: "x", manifest: m("a") }), "modified");
    assert.equal(classify("b", { digest: "a", manifest: null }), "unmanaged");
  });

  it("auto targets every CLI on PATH and every home that has a skill already", () => {
    assert.deepEqual(
      resolveSkillTargets("auto", () => false),
      ["claude"],
    );
    assert.deepEqual(
      resolveSkillTargets("auto", (rt) => rt === "codex"),
      ["codex"],
    );
    assert.deepEqual(
      resolveSkillTargets(
        "auto",
        (rt) => rt === "codex",
        (rt) => rt === "claude",
      ),
      ["claude", "codex"],
    );
    assert.deepEqual(
      resolveSkillTargets("all", () => false),
      ["claude", "codex"],
    );
  });

  it("the startup notice names only installed skills that fell behind", () => {
    const row = (
      skill: "argus-pipeline" | "argus-tail",
      state: "missing" | "current" | "outdated" | "modified",
    ) => ({
      skill,
      runtime: "claude" as const,
      dir: "/d",
      state,
      installedVersion: null,
      managed: true,
    });
    assert.equal(
      staleSkillsNotice([row("argus-pipeline", "missing"), row("argus-tail", "current")]),
      null,
    );
    assert.match(
      staleSkillsNotice([row("argus-pipeline", "outdated"), row("argus-tail", "modified")]) ?? "",
      /argus-pipeline \(Claude Code\), argus-tail \(Claude Code\) — run `argus skills install`/,
    );
  });
});

describe("the skills this repository ships", () => {
  /** Every file under a folder, relative. */
  function files(dir: string, rel = ""): string[] {
    return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(dir, path.join(rel, e.name)) : [path.join(rel, e.name)],
    );
  }

  for (const name of BUNDLED_SKILLS) {
    it(`${name}: SKILL.md names itself, and the Codex copy is identical`, () => {
      const dir = bundledSkillDir(name);
      const skill = readFileSync(path.join(dir, "SKILL.md"), "utf8");
      assert.match(
        skill,
        new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: .+\\r?\\n---\\r?\\n`),
      );
      // `.agents/skills/<name>/` is what Codex reads in this repository: a
      // plain copy, not a symlink, so a checkout without symlink support
      // (Windows by default) still has it. Edit one, copy it over the other.
      const viaAgents = path.join(argusRoot(), ".agents", "skills", name);
      assert.equal(lstatSync(viaAgents).isDirectory(), true, "a real folder, not a link");
      const ours = files(dir).sort();
      assert.deepEqual(files(viaAgents).sort(), ours);
      for (const f of ours) {
        assert.equal(
          readFileSync(path.join(viaAgents, f), "utf8"),
          readFileSync(path.join(dir, f), "utf8"),
          f,
        );
      }
    });
  }

  it("installs from the real build into a home", async () => {
    await withHomes(async (homes) => {
      const results = await installSkills(BUNDLED_SKILLS, "all", io());
      assert.equal(
        results.filter((r) => r.action === "installed").length,
        BUNDLED_SKILLS.length * 2,
      );
      const installed = readFileSync(
        path.join(installedSkillDir("argus-pipeline", "codex", homes.codex), "SKILL.md"),
        "utf8",
      );
      assert.equal(installed.includes(ROOT_PLACEHOLDER), false);
    });
  });
});
