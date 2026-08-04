import { existsSync, lstatSync, realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadPackConfig, parseSourceId, projectSourceRoot, type SourceKind } from "./config.ts";
import { walkFiles } from "./fs.ts";
import type { Contribution, HarnessName, PackConfig, SkillIdentity, SourceId } from "./types.ts";
import { readSkillIdentity } from "./skills.ts";

export interface SourceContext {
  sourceRoot?: string;
  projectRoot?: string;
}

export interface LoadedTemplate {
  selection: string;
  sourceId: string;
  path: string;
  content: string;
}

export interface LoadedPack {
  selection: string;
  sourceId: string;
  directory: string;
  config: PackConfig;
}

interface ResolvedSource {
  selection: string;
  sourceId: string;
  directory: string;
}

function kindPath(kind: SourceKind): string {
  return kind === "template" ? "templates" : kind === "pack" ? "packs" : kind === "skill" ? "skills" : "partials";
}

function ownerRoot(context: SourceContext, owner: "source" | "project"): string | undefined {
  if (owner === "source") return context.sourceRoot === undefined ? undefined : resolve(context.sourceRoot);
  if (context.projectRoot === undefined) return undefined;
  const projectRoot = resolve(context.projectRoot);
  const sourceRoot = projectSourceRoot(projectRoot);
  let current = projectRoot;
  for (const segment of relative(projectRoot, sourceRoot).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return sourceRoot;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`project source root traverses symlink ${current}`);
  }
  contained(realpathSync(projectRoot), realpathSync(sourceRoot), "project source root");
  return sourceRoot;
}

function canonicalSourceId(owner: "source" | "project", name: string): string {
  return `${owner}:${name}`;
}

function contained(root: string, candidate: string, label: string): string {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes ${rootPath}`);
  return candidatePath;
}

function candidatePath(context: SourceContext, id: SourceId, kind: SourceKind, owner: "source" | "project"): string | undefined {
  const root = ownerRoot(context, owner);
  if (root === undefined) return undefined;
  return contained(root, join(root, kindPath(kind), ...id.name.split("/")), `${kind} Source ID`);
}

function validateSourcePath(root: string, path: string, kind: SourceKind, sourceId: string): string {
  let current = root;
  if (lstatSync(current).isSymbolicLink()) throw new Error(`source root is a symlink: ${current}`);
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${kind} source ${JSON.stringify(sourceId)} traverses symlink ${current}`);
  }
  contained(realpathSync(root), realpathSync(path), `${kind} Source ID`);
  const stat = lstatSync(path);
  if (kind === "partial") {
    if (!stat.isFile()) throw new Error(`partial source ${JSON.stringify(sourceId)} is not a file`);
  } else if (!stat.isDirectory()) {
    throw new Error(`${kind} source ${JSON.stringify(sourceId)} is not a directory`);
  }
  return path;
}

function findOwnedSource(context: SourceContext, id: SourceId, kind: SourceKind, owner: "source" | "project"): ResolvedSource | undefined {
  const root = ownerRoot(context, owner);
  const path = candidatePath(context, id, kind, owner);
  if (root === undefined || path === undefined || !existsSync(path)) return undefined;
  const sourceId = canonicalSourceId(owner, id.name);
  return { selection: id.raw, sourceId, directory: validateSourcePath(root, path, kind, sourceId) };
}

function requiredOwners(context: SourceContext, id: SourceId, policy: "singular" | "pack"): Array<"source" | "project"> {
  if (id.owner !== undefined) return [id.owner];
  if (policy === "pack") {
    return [context.sourceRoot === undefined ? undefined : "source", context.projectRoot === undefined ? undefined : "project"].filter(
      (owner): owner is "source" | "project" => owner !== undefined,
    );
  }
  return [context.projectRoot === undefined ? undefined : "project", context.sourceRoot === undefined ? undefined : "source"].filter(
    (owner): owner is "source" | "project" => owner !== undefined,
  );
}

function missingSource(context: SourceContext, id: SourceId, kind: SourceKind, owners: Array<"source" | "project">): never {
  if (id.owner === "source" && context.sourceRoot === undefined) {
    throw new Error(`Source ID ${JSON.stringify(id.raw)} requires machine configuration with a Source Repository`);
  }
  if (id.owner === "project" && context.projectRoot === undefined) {
    throw new Error(`Source ID ${JSON.stringify(id.raw)} requires a project root`);
  }
  const searched = owners
    .map((owner) => candidatePath(context, id, kind, owner))
    .filter((path): path is string => path !== undefined)
    .join(", ");
  throw new Error(`missing ${kind} source ${JSON.stringify(id.raw)}${searched ? `; searched ${searched}` : ""}`);
}

function resolveSingularSource(context: SourceContext, sourceId: string, kind: Exclude<SourceKind, "pack">): ResolvedSource {
  const id = parseSourceId(sourceId);
  const owners = requiredOwners(context, id, "singular");
  for (const owner of owners) {
    const match = findOwnedSource(context, id, kind, owner);
    if (match !== undefined) return match;
  }
  return missingSource(context, id, kind, owners);
}

export async function loadTemplate(context: SourceContext, family: string, harness: HarnessName): Promise<LoadedTemplate> {
  const resolved = resolveSingularSource(context, family, "template");
  const harnessPath = join(resolved.directory, `${harness}.md`);
  const defaultPath = join(resolved.directory, "default.md");
  const path = existsSync(harnessPath) ? harnessPath : defaultPath;
  if (!existsSync(path)) {
    throw new Error(`Template family ${JSON.stringify(family)} has neither ${harness}.md nor default.md`);
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Template must be a regular non-symlink file: ${path}`);
  return { selection: family, sourceId: resolved.sourceId, path, content: await readFile(path, "utf8") };
}

export function loadPacks(context: SourceContext, selections: string[]): LoadedPack[] {
  const loaded: LoadedPack[] = [];
  const seen = new Map<string, string>();
  for (const selection of selections) {
    const id = parseSourceId(selection);
    const owners = requiredOwners(context, id, "pack");
    const matches = owners.map((owner) => findOwnedSource(context, id, "pack", owner)).filter((match): match is ResolvedSource => match !== undefined);
    if (matches.length === 0) missingSource(context, id, "pack", owners);
    for (const match of matches) {
      const previous = seen.get(match.sourceId);
      if (previous !== undefined) {
        throw new Error(`duplicate resolved pack source ${match.sourceId} from selections ${JSON.stringify(previous)} and ${JSON.stringify(selection)}`);
      }
      seen.set(match.sourceId, selection);
      loaded.push({ selection, sourceId: match.sourceId, directory: match.directory, config: loadPackConfig(match.directory) });
    }
  }
  return loaded;
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
  const resolved = resolveSingularSource(context, sourceId, "skill");
  return readSkillIdentity(resolved.directory, resolved.sourceId);
}

export async function resolvePartial(context: SourceContext, sourceId: string): Promise<{ path: string; content: string }> {
  const resolved = resolveSingularSource(context, sourceId, "partial");
  return { path: resolved.directory, content: await readFile(resolved.directory, "utf8") };
}
