import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Server package version, read once at import. Surfaced on /api/health. */
function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
