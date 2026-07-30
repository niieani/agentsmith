import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPackConfig, parseSourceId, resolveSourceDir } from "./config.ts";
import { walkFiles } from "./fs.ts";
import type { Contribution, HarnessName, PackConfig, SkillIdentity } from "./types.ts";
import { readSkillIdentity } from "./skills.ts";

export interface SourceContext {
  sourceRoot?: string;
  projectRoot?: string;
}

export interface LoadedTemplate {
  sourceId: string;
  path: string;
  content: string;
}

export interface LoadedPack {
  sourceId: string;
  directory: string;
  config: PackConfig;
}

function roots(context: SourceContext): { sourceRoot: string; projectRoot?: string } {
  return { sourceRoot: context.sourceRoot ?? "", projectRoot: context.projectRoot };
}

export function resolveOwnedSource(context: SourceContext, sourceId: string, kind: "template" | "pack" | "skill" | "partial"): string {
  const id = parseSourceId(sourceId);
  if (id.owner === "source" && !context.sourceRoot) {
    throw new Error(`Source ID ${JSON.stringify(sourceId)} requires machine configuration with a Source Repository`);
  }
  return resolveSourceDir(id, kind, roots(context).sourceRoot, context.projectRoot);
}

export async function loadTemplate(context: SourceContext, family: string, harness: HarnessName): Promise<LoadedTemplate> {
  const directory = resolveOwnedSource(context, family, "template");
  const harnessPath = join(directory, `${harness}.md`);
  const defaultPath = join(directory, "default.md");
  const path = existsSync(harnessPath) ? harnessPath : defaultPath;
  if (!existsSync(path)) {
    throw new Error(`Template family ${JSON.stringify(family)} has neither ${harness}.md nor default.md`);
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Template must be a regular non-symlink file: ${path}`);
  return { sourceId: family, path, content: await readFile(path, "utf8") };
}

export function loadPack(context: SourceContext, sourceId: string): LoadedPack {
  const directory = resolveOwnedSource(context, sourceId, "pack");
  return { sourceId, directory, config: loadPackConfig(directory) };
}

async function markdownContributions(directory: string, pack: string, slot: string): Promise<Contribution[]> {
  if (!existsSync(directory)) return [];
  const files = await walkFiles(directory);
  return files
    .filter((file) => file.relativePath.endsWith(".md"))
    .map((file) => ({
      pack,
      slot,
      path: file.absolutePath,
      content: new TextDecoder().decode(file.content),
    }));
}

async function contributionsBySlot(root: string, pack: string): Promise<Contribution[]> {
  if (!existsSync(root)) return [];
  if ((await lstat(root)).isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${root}`);
  const entries = await (await import("node:fs/promises")).readdir(root, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const contributions: Contribution[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${path}`);
    if (!entry.isDirectory()) continue;
    contributions.push(...(await markdownContributions(path, pack, entry.name)));
  }
  return contributions;
}

export async function loadInstructionContributions(pack: LoadedPack, harness: HarnessName): Promise<Contribution[]> {
  const commonRoot = join(pack.directory, "instructions");
  const common = existsSync(commonRoot)
    ? (await contributionsBySlot(commonRoot, pack.sourceId)).filter((item) => {
        const first = item.path.slice(commonRoot.length + 1).split(/[\\/]/)[0];
        return first !== "codex" && first !== "claude-code";
      })
    : [];
  const specific = await contributionsBySlot(join(commonRoot, harness), pack.sourceId);
  return [...common, ...specific];
}

export async function loadSkillContributions(pack: LoadedPack, harness: HarnessName): Promise<Contribution[]> {
  const root = join(pack.directory, "skill-slots");
  const common = existsSync(root)
    ? (await contributionsBySlot(root, pack.sourceId)).filter((item) => {
        const first = item.path.slice(root.length + 1).split(/[\\/]/)[0];
        return first !== "harnesses";
      })
    : [];
  const specific = await contributionsBySlot(join(root, "harnesses", harness), pack.sourceId);
  return [...common, ...specific];
}

export async function loadSkill(context: SourceContext, sourceId: string): Promise<SkillIdentity> {
  const directory = resolveOwnedSource(context, sourceId, "skill");
  return readSkillIdentity(directory, sourceId);
}

export async function resolvePartial(context: SourceContext, sourceId: string): Promise<{ path: string; content: string }> {
  const path = resolveOwnedSource(context, sourceId, "partial");
  return { path, content: await readFile(path, "utf8") };
}
