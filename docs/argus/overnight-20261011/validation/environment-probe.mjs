import { mkdtemp, writeFile, rename, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

console.log(
  JSON.stringify({
    node: process.version,
    executable: process.execPath,
    platform: process.platform,
  }),
);
for (const [label, root] of [
  ["temporary", tmpdir()],
  ["checkout", process.cwd()],
]) {
  const directory = await mkdtemp(path.join(root, "argus-overnight-probe-"));
  try {
    const target = path.join(directory, "target.json");
    const replacement = path.join(directory, "replacement.tmp");
    await writeFile(target, "before");
    await writeFile(replacement, "after");
    await rename(replacement, target);
    console.log(
      JSON.stringify({
        probe: "replace-existing",
        location: label,
        result: await readFile(target, "utf8"),
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        probe: "replace-existing",
        location: label,
        error: error.message,
        code: error.code,
      }),
    );
  } finally {
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(root) ||
      !path.basename(directory).startsWith("argus-overnight-probe-")
    )
      throw new Error("Unsafe cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
}
try {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  try {
    const compiled = database
      .prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
      .get();
    console.log(JSON.stringify({ probe: "fts5-compile-option", ...compiled }));
    database.exec("CREATE VIRTUAL TABLE probe USING fts5(body)");
    console.log(JSON.stringify({ probe: "fts5-table", result: "created" }));
  } finally {
    database.close();
  }
} catch (error) {
  console.log(JSON.stringify({ probe: "fts5", error: error.message, code: error.code }));
}
