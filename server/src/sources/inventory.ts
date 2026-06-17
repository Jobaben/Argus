import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { claudeHome } from "../claudeHome.js";
import { readJson } from "./readJson.js";

/** A markdown-defined item (agent, command, or skill) with parsed frontmatter. */
export interface InventoryItem {
  name: string;
  description: string;
}

/** An installed plugin, derived from `plugins/installed_plugins.json`. */
export interface PluginItem {
  name: string;
  description: string;
  version: string;
  marketplace: string;
}

export interface Inventory {
  agents: InventoryItem[];
  commands: InventoryItem[];
  skills: InventoryItem[];
  plugins: PluginItem[];
}

/**
 * Parses a leading YAML frontmatter block (between `---` fences) into a flat
 * key/value map. Only the simple `key: value` form is supported, which is all
 * the agent/command/skill files use; nested structures are ignored.
 */
function parseFrontmatter(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!raw.startsWith("---")) return fields;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return fields;
  const block = raw.slice(3, end);
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, value] = match;
    fields[key.toLowerCase()] = value.trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

/** First non-empty markdown line, used as a fallback description. */
function firstProse(raw: string): string {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---" || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return "";
}

async function readMarkdownItems(dir: string): Promise<InventoryItem[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const items: InventoryItem[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    let raw: string;
    try {
      raw = await readFile(path.join(dir, entry), "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    items.push({
      name: fm.name || entry.replace(/\.md$/, ""),
      description: fm.description || firstProse(raw),
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** Raw shape of `plugins/installed_plugins.json` (v2). */
interface InstalledPlugins {
  plugins?: Record<string, Array<{ version?: string }>>;
}

async function readPlugins(): Promise<PluginItem[]> {
  const file = path.join(claudeHome(), "plugins", "installed_plugins.json");
  const data = await readJson<InstalledPlugins>(file, {});
  const items: PluginItem[] = [];
  for (const [key, installs] of Object.entries(data.plugins ?? {})) {
    const at = key.lastIndexOf("@");
    const name = at === -1 ? key : key.slice(0, at);
    const marketplace = at === -1 ? "" : key.slice(at + 1);
    const version = installs?.[0]?.version ?? "unknown";
    items.push({
      name,
      marketplace,
      version,
      description: marketplace ? `from ${marketplace}` : "",
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** Builds the full extensions inventory under `~/.claude`. */
export async function readInventory(): Promise<Inventory> {
  const root = claudeHome();
  const [agents, commands, skills, plugins] = await Promise.all([
    readMarkdownItems(path.join(root, "agents")),
    readMarkdownItems(path.join(root, "commands")),
    readMarkdownItems(path.join(root, "skills")),
    readPlugins(),
  ]);
  return { agents, commands, skills, plugins };
}
