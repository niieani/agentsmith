import { existsSync, lstatSync, realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse, stringify } from "smol-toml";
import { commitSourcePaths, globalTarget, projectTarget, type AddTarget } from "./add.ts";
import { generateProject, recordedPaths, runRecordedGlobal } from "./commands.ts";
import { projectSourceRoot } from "./config.ts";
import { AgentsmithError, classify, errorCode, errorMessage } from "./errors.ts";
import { isWithin, walkFiles } from "./fs.ts";
import { gitPullFfOnly, gitWorktree, runCommand } from "./git.ts";
import { skillReadRoots } from "./harness.ts";
import { assertPlanValid } from "./planner.ts";
import { atomicWrite, globalBackupRoot, projectBackupRoot, quarantinePaths } from "./safety.ts";
import { parseSkillIdentity } from "./skills.ts";

export interface AdoptSkillOptions {
  skill: string;
  pack?: string;
  config?: string;
  project?: string;
  scope?: string;
  push?: boolean;
  noCommit?: boolean;
  dryRun?: boolean;
}

/**
 * Add `name` to a pack manifest's `skills`, keeping the rest of the file as written. A missing or empty manifest gets
 * a new `skills` line; a manifest that already lists the name is returned unchanged.
 */
export function appendPackSkill(content: string | undefined, name: string): string {
  const entry = JSON.stringify(name);
  if (content === undefined || content.trim() === "") return `skills = [${entry}]\n`;
  const parsed = parse(content) as { skills?: string[] };
  const skills = parsed.skills ?? [];
  if (skills.includes(name)) return content;
  const expected = [...skills, name];
  const match = /^([ \t]*skills[ \t]*=[ \t]*\[)([\s\S]*?)\]/m.exec(content);
  let updated: string | undefined;
  if (match === null) {
    updated = `skills = [${entry}]\n${content}`;
  } else {
    const body = match[2]!;
    const trimmed = body.trimEnd();
    let next: string;
    if (trimmed.trim() === "") next = entry;
    else if (body.includes("\n")) next = `${trimmed}${trimmed.endsWith(",") ? "" : ","}\n  ${entry},\n`;
    else next = `${trimmed}${trimmed.endsWith(",") ? "" : ","} ${entry}`;
    updated = `${content.slice(0, match.index)}${match[1]}${next}]${content.slice(match.index + match[0].length)}`;
  }
  try {
    const reparsed = parse(updated) as { skills?: string[] };
    if (JSON.stringify(reparsed.skills) === JSON.stringify(expected)) return updated;
  } catch {
    // Fall through to a rewrite that drops formatting but is always valid.
  }
  return stringify({ ...parsed, skills: expected });
}

async function trackedClean(root: string, path: string): Promise<boolean> {
  const rel = relative(root, path).split(sep).join("/");
  const tracked = await runCommand("git", ["ls-files", "--", rel], { cwd: root, allowFailure: true });
  const status = await runCommand("git", ["status", "--porcelain", "--untracked-files=all", "--", rel], { cwd: root, allowFailure: true });
  return tracked.exitCode === 0 && tracked.stdout.trim() !== "" && status.exitCode === 0 && status.stdout.trim() === "";
}

function validSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** Every existing unmanaged directory named `name` in the Skill Roots read by the target's harnesses. */
async function findUnmanagedSkill(target: AddTarget, name: string): Promise<{ candidates: string[]; roots: string[] }> {
  const location =
    target.mode === "global"
      ? { mode: "global" as const, home: target.plan.home }
      : { mode: "project" as const, projectRoot: target.plan.projectRoot!, scopePath: target.scope };
  const roots = [...new Set(target.harnesses.flatMap((harness) => skillReadRoots(harness, location)))];
  const managed = [...target.plan.plannedPaths, ...(await recordedPaths(target.plan))];
  const candidates: string[] = [];
  for (const root of roots) {
    const path = join(root, name);
    let present = false;
    try {
      lstatSync(path);
      present = true;
    } catch {
      present = false;
    }
    if (present && !managed.some((file) => isWithin(path, file))) candidates.push(path);
  }
  return { candidates, roots };
}

/**
 * Copy an unmanaged skill into the Source Repository (global) or the project's source tree, enable it in a pack, lint,
 * commit (global, unless `--no-commit`), move the original aside, and regenerate so the skill becomes managed.
 */
export async function adoptSkill(mode: "global" | "project", options: AdoptSkillOptions): Promise<void> {
  const name = options.skill;
  if (!validSkillName(name)) throw new AgentsmithError("config", `Invalid skill name ${JSON.stringify(name)}; name one skill directory`);
  if (options.push && options.noCommit) throw new AgentsmithError("config", "--push cannot be combined with --no-commit");
  const target = mode === "global" ? await globalTarget(options, "global adopt") : await projectTarget(options, "adopt");
  const commit = mode === "global" && !options.noCommit;

  if (options.push && !options.dryRun) {
    await gitPullFfOnly(target.sourceRoot);
    target.plan = await target.rebuild();
  }
  await classify("config", () => assertPlanValid(target.plan));

  const skillsRoot = mode === "global" ? join(target.sourceRoot, "skills") : join(projectSourceRoot(target.sourceRoot), "skills");
  const destination = join(skillsRoot, name);
  if (existsSync(destination)) throw new AgentsmithError("config", `Skill ${name} already exists in the source tree: ${destination}`);
  const manifest = join(target.packDirectory, "pack.toml");
  if (commit) {
    const relativeManifest = relative(target.sourceRoot, manifest).split(sep).join("/");
    const dirty = await runCommand("git", ["status", "--porcelain", "--", relativeManifest], { cwd: target.sourceRoot });
    if (dirty.stdout.trim()) {
      throw new AgentsmithError("config", `${manifest} has uncommitted changes; commit them first or pass --no-commit`);
    }
  }

  const { candidates, roots } = await findUnmanagedSkill(target, name);
  if (candidates.length === 0) {
    throw new AgentsmithError(
      "config",
      `No unmanaged ${mode} skill named ${name} in ${target.scopeLabel}. Skill Roots searched:\n${roots.map((root) => `  ${root}`).join("\n")}`,
    );
  }
  // A skill linked into several roots (as `npx skills add` does) is one skill; different directories are ambiguous.
  const real = [...new Set(candidates.map((path) => realpathSync(path)))];
  if (real.length > 1) {
    throw new AgentsmithError(
      "config",
      `Several different unmanaged skills are named ${name}; keep one and remove the others:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
    );
  }
  const sourceDirectory = real[0]!;
  const skillFile = join(sourceDirectory, "SKILL.md");
  if (!existsSync(skillFile)) throw new AgentsmithError("config", `${candidates[0]} has no SKILL.md, so it is not a skill`);
  await classify("config", async () => parseSkillIdentity(await readFile(skillFile, "utf8"), join(skillsRoot, name), `adopted:${name}`));
  const files = await classify("config", () => walkFiles(sourceDirectory));

  const previousManifest = existsSync(manifest) ? await readFile(manifest, "utf8") : undefined;
  const nextManifest = await classify("config", () => appendPackSkill(previousManifest, name));

  const verb = options.dryRun ? "Would adopt" : "Adopting";
  console.log(`${verb} skill ${name} from ${candidates.join(", ")}`);
  console.log(`  ${options.dryRun ? "would copy" : "copying"} ${files.length} file(s) to ${destination}`);
  console.log(`  ${options.dryRun ? "would enable" : "enabling"} it in pack ${target.packName} (${manifest})`);
  if (options.dryRun) return;

  const rollback = async () => {
    await rm(destination, { recursive: true, force: true });
    if (previousManifest === undefined) await rm(manifest, { force: true });
    else await atomicWrite(manifest, new TextEncoder().encode(previousManifest));
  };
  try {
    for (const file of files) await atomicWrite(join(destination, file.relativePath), file.content, file.mode);
    await atomicWrite(manifest, new TextEncoder().encode(nextManifest));
    const linted = await target.rebuild();
    await classify("config", () => assertPlanValid(linted));
    if (!linted.writes.some((write) => write.kind === "skill" && write.provenance.some((path) => isWithin(destination, path)))) {
      throw new AgentsmithError("config", `Skill ${name} is not generated for ${target.scopeLabel} after enabling it in pack ${target.packName}`);
    }
  } catch (cause) {
    await rollback();
    throw new AgentsmithError(
      errorCode(cause) === "failure" ? "config" : errorCode(cause),
      `Lint failed; reverted the adoption of ${name}:\n${errorMessage(cause)}`,
      {
        cause,
      },
    );
  }

  if (commit) {
    await commitSourcePaths(target.sourceRoot, [destination, manifest], { message: `Adopt skill ${name}`, push: options.push === true, rollback });
  } else if (mode === "global") {
    console.log(`  not committed: commit and push it in ${target.sourceRoot} before the next global sync, which refuses a dirty Source Repository`);
  }

  const backupRoot = mode === "global" ? globalBackupRoot(target.plan.home) : projectBackupRoot(await gitWorktree(target.sourceRoot));
  // A tracked, clean project skill at its planned destination is replaced in place by identical content; moving it
  // aside would make Git report the destination as deleted and stop project generation.
  const aside: string[] = [];
  for (const path of candidates) {
    if (mode === "project" && (await trackedClean(target.sourceRoot, path))) continue;
    aside.push(path);
  }
  const moved = await quarantinePaths(aside, { backupRoot });
  for (const backup of moved) console.log(`  moved the original ${backup.path} to ${backup.backup}`);
  try {
    if (mode === "global") await runRecordedGlobal("generate", { config: options.config });
    else await generateProject(await target.rebuild());
  } catch (cause) {
    throw new AgentsmithError(
      errorCode(cause),
      `Adopted skill ${name} into ${destination}, but regeneration failed; the adopted source was kept:\n${errorMessage(cause)}`,
      {
        cause,
      },
    );
  }
  console.log(`Adopted skill ${name} into pack ${target.packName}.`);
}
