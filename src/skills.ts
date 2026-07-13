import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, SkillIdentity } from "./types.ts";

function scalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillIdentity(content: string, sourceDir: string, sourceId: string): SkillIdentity {
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new Error(`${join(sourceDir, "SKILL.md")} must begin with YAML front matter`);
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    throw new Error(`${join(sourceDir, "SKILL.md")} has unterminated YAML front matter`);
  }
  let name: string | undefined;
  let description: string | undefined;
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === "name") name = scalar(match[2] ?? "");
    if (match[1] === "description") description = scalar(match[2] ?? "");
  }
  if (!name) throw new Error(`${join(sourceDir, "SKILL.md")} is missing front matter name`);
  if (!description) throw new Error(`${join(sourceDir, "SKILL.md")} is missing front matter description`);
  const basename = sourceDir.split(/[\\/]/).filter(Boolean).at(-1);
  if (name !== basename) {
    throw new Error(`Skill name ${JSON.stringify(name)} must match source directory ${JSON.stringify(basename)}`);
  }
  return { sourceId, name, description, sourceDir };
}

export async function readSkillIdentity(sourceDir: string, sourceId: string): Promise<SkillIdentity> {
  return parseSkillIdentity(await readFile(join(sourceDir, "SKILL.md"), "utf8"), sourceDir, sourceId);
}

export async function scanSkillRoot(root: string): Promise<{ skills: SkillIdentity[]; diagnostics: Diagnostic[] }> {
  const skills: SkillIdentity[] = [];
  const diagnostics: Diagnostic[] = [];
  if (!existsSync(root)) return { skills, diagnostics };
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceDir = join(root, entry.name);
    try {
      skills.push(await readSkillIdentity(sourceDir, `unmanaged:${sourceDir}`));
    } catch (error) {
      diagnostics.push({
        severity: "warning",
        code: "unmanaged-skill-invalid",
        message: error instanceof Error ? error.message : String(error),
        path: sourceDir,
      });
    }
  }
  return { skills, diagnostics };
}
