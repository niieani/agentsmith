import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { generateProject, runRecordedGlobal } from "./commands.ts";
import {
  discoverProjectConfig,
  loadMachineConfig,
  loadProfileConfig,
  loadProjectConfig,
  MACHINE_CONFIG_PATH,
  parseSourceId,
  projectSourceRoot,
  resolveConfiguredPath,
} from "./config.ts";
import { AgentsmithError, classify, errorCode, errorMessage } from "./errors.ts";
import { canonicalRoot } from "./fs.ts";
import { gitHeadCommit, gitIsIgnored, gitPullFfOnly, runCommand } from "./git.ts";
import { validLogicalName } from "./markdown.ts";
import { assertPlanValid, buildGlobalPlan, buildProjectPlan, type BuiltPlan, type SlotTarget } from "./planner.ts";
import { atomicWrite } from "./safety.ts";
import { HARNESS_NAMES, type HarnessName } from "./types.ts";

export type Placement = "gap" | "first" | "last";

/** The prefix an empty slot starts at, leaving room on both sides. */
export const EMPTY_SLOT_NUMBER = 50;

export interface AddOptions {
  slot: string;
  text?: string;
  file?: string;
  skillSlot?: boolean;
  harness?: HarnessName;
  pack?: string;
  placement?: Placement;
  name?: string;
  local?: boolean;
  push?: boolean;
  /** Global only: leave the new snippet uncommitted. Without it, a non-local global snippet is committed. */
  noCommit?: boolean;
  skipGenerate?: boolean;
  dryRun?: boolean;
  config?: string;
  project?: string;
  scope?: string;
}

/**
 * Choose the pack a command writes to: the requested one, which must be a candidate, or the only candidate.
 * With several candidates and no request the choice is ambiguous and `--pack` is required.
 */
export function choosePack(candidates: readonly string[], requested: string | undefined, owner: string): string {
  const names = [...new Set(candidates.map((candidate) => parseSourceId(candidate).name))];
  if (requested !== undefined) {
    const name = parseSourceId(requested).name;
    if (!names.includes(name)) {
      throw new AgentsmithError("config", `Pack ${name} is not ${owner}${names.length > 0 ? ` (candidates: ${names.join(", ")})` : ""}`);
    }
    return name;
  }
  if (names.length === 1) return names[0]!;
  if (names.length === 0) throw new AgentsmithError("config", `There is no pack ${owner}`);
  throw new AgentsmithError("config", `--pack is required because there are several packs ${owner}: ${names.join(", ")}`);
}

/** The two-digit prefix of a slot entry named `NN-...`, or undefined for entries without one. */
export function snippetPrefix(name: string): number | undefined {
  const match = /^(\d{2})-/.exec(name);
  return match ? Number(match[1]) : undefined;
}

export interface NumberChoice {
  number: number;
  reason: string;
}

const two = (value: number) => String(value).padStart(2, "0");

/**
 * Choose the prefix for a new snippet among existing entry names of one slot directory. Entries without a
 * two-digit `NN-` prefix are ignored. Existing files are never renamed.
 *
 * - `gap`: the number directly after the lower neighbor of the largest run of free numbers following an existing
 *   prefix, counting the run between consecutive prefixes and the run above the highest prefix up to 99. Ties take
 *   the lowest run.
 * - `first`: directly below the lowest prefix. `last`: directly above the highest prefix.
 * - An empty slot starts at 50 for every placement.
 */
export function chooseSnippetNumber(entries: readonly string[], placement: Placement = "gap"): NumberChoice {
  const prefixes = [...new Set(entries.map(snippetPrefix).filter((value): value is number => value !== undefined))].sort((a, b) => a - b);
  if (prefixes.length === 0) return { number: EMPTY_SLOT_NUMBER, reason: `empty slot, starting at ${EMPTY_SLOT_NUMBER}` };
  const lowest = prefixes[0]!;
  const highest = prefixes.at(-1)!;
  if (placement === "first") {
    if (lowest === 0) throw new AgentsmithError("config", "No number is free below the lowest prefix 00; existing snippets are never renamed");
    return { number: lowest - 1, reason: `first, directly below the lowest prefix ${two(lowest)}` };
  }
  if (placement === "last") {
    if (highest === 99) throw new AgentsmithError("config", "No number is free above the highest prefix 99; existing snippets are never renamed");
    return { number: highest + 1, reason: `last, directly above the highest prefix ${two(highest)}` };
  }
  let best: { lower: number; upper: number; free: number } | undefined;
  for (let index = 0; index < prefixes.length; index++) {
    const lower = prefixes[index]!;
    const upper = prefixes[index + 1] ?? 100;
    const free = upper - lower - 1;
    if (free > 0 && (best === undefined || free > best.free)) best = { lower, upper, free };
  }
  if (best === undefined) {
    const hint = lowest > 0 ? "; use --placement first" : "; existing snippets are never renamed";
    throw new AgentsmithError("config", `No number is free after any existing snippet prefix${hint}`);
  }
  const bound = best.upper === 100 ? "the end" : two(best.upper);
  return { number: best.lower + 1, reason: `gap, directly after ${two(best.lower)}, the lower neighbor of the largest gap (${two(best.lower)} to ${bound})` };
}

const MAX_SLUG_LENGTH = 48;

/** A lowercase ASCII file-name slug: words joined by hyphens, at most six words and 48 characters. */
export function slugify(value: string): string {
  const words = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 6);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_SLUG_LENGTH) break;
    slug = next;
  }
  return slug || words[0]?.slice(0, MAX_SLUG_LENGTH) || "";
}

/** The slug for a snippet: from `--name` when given, otherwise from the first line of text in the content. */
export function snippetSlug(content: string, name?: string): string {
  if (name !== undefined) {
    const slug = slugify(name.replace(/(?:\.local)?\.md$/i, ""));
    if (!slug) throw new AgentsmithError("config", `--name ${JSON.stringify(name)} contains no letters or digits`);
    return slug;
  }
  const line = content.split(/\r?\n/).find((item) => /[\p{L}\p{N}]/u.test(item)) ?? "";
  return slugify(line) || "snippet";
}

/** The new snippet's file name, `NN-<slug>.md` or `NN-<slug>.local.md`. */
export function snippetFileName(number: number, slug: string, local = false): string {
  return `${two(number)}-${slug}${local ? ".local" : ""}.md`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function snippetContent(options: AddOptions): Promise<string> {
  if (options.text !== undefined && options.file !== undefined) {
    throw new AgentsmithError("config", "Pass the snippet as text or with --file, not both");
  }
  let content: string;
  if (options.text !== undefined) content = options.text;
  else if (options.file !== undefined) content = await classify("config", () => readFile(resolve(options.file!), "utf8"));
  else if (process.stdin.isTTY) throw new AgentsmithError("config", "Pass the snippet as text, with --file PATH, or on standard input");
  else content = await readStdin();
  content = content.replace(/\r\n?/g, "\n");
  if (!content.trim()) throw new AgentsmithError("config", "The snippet is empty");
  return content.endsWith("\n") ? content : `${content}\n`;
}

/** What `add` validated about the slot: the matching targets and, for errors, every slot that exists. */
interface SlotResolution {
  receivers: SlotTarget[];
}

function describeTarget(target: SlotTarget, mode: "global" | "project"): string {
  const where = mode === "project" ? ` (scope ${target.scope})` : "";
  return target.kind === "skill" ? `${target.skill}${where}` : `${target.harnesses.join("+")} ${target.destination}`;
}

function slotList(targets: readonly SlotTarget[]): string {
  const slots = [...new Set(targets.flatMap((target) => target.slots))].sort();
  return slots.length > 0 ? slots.join(", ") : "(none)";
}

/**
 * Check the slot against the plan: an instruction slot must be declared by every Instruction Layer the snippet
 * renders into, a skill slot by at least one enabled skill receiving it.
 */
export function resolveSlot(
  plan: Pick<BuiltPlan, "slotTargets" | "mode">,
  options: { slot: string; skillSlot?: boolean; harness?: HarnessName; scope: string; scopeLabel: string },
): SlotResolution {
  const { slot, harness } = options;
  const inScope = plan.slotTargets.filter((target) => target.scope === options.scope);
  const forHarness = harness === undefined ? "" : ` for ${harness}`;
  if (options.skillSlot) {
    const skills = inScope.filter((target) => target.kind === "skill");
    // A harness-specific skill snippet renders only into roots read by that harness alone.
    const eligible = harness === undefined ? skills : skills.filter((target) => target.exclusiveReader === harness);
    const receivers = eligible.filter((target) => target.slots.includes(slot));
    if (receivers.length === 0) {
      throw new AgentsmithError(
        "config",
        `No enabled skill${harness === undefined ? "" : ` read only by ${harness}`} in ${options.scopeLabel} declares skill slot ${slot}. Skill slots: ${slotList(eligible)}`,
      );
    }
    return { receivers };
  }
  const layers = inScope.filter((target) => target.kind === "instruction" && (harness === undefined || target.harnesses.includes(harness)));
  if (layers.length === 0) {
    throw new AgentsmithError("config", `${options.scopeLabel} has no Instruction Layer${forHarness}, so it has no instruction slots`);
  }
  const declaring = layers.filter((target) => target.slots.includes(slot));
  if (declaring.length === 0) {
    throw new AgentsmithError("config", `No template in ${options.scopeLabel} declares slot ${slot}${forHarness}. Slots: ${slotList(layers)}`);
  }
  if (declaring.length < layers.length) {
    // A common snippet reaches every Instruction Layer of the scope; a layer without the slot fails lint.
    const missing = layers.filter((target) => !target.slots.includes(slot));
    const owners = [...new Set(declaring.flatMap((target) => target.harnesses))];
    throw new AgentsmithError(
      "config",
      `Slot ${slot} is not declared for ${missing.map((target) => target.harnesses.join("+")).join(", ")} in ${options.scopeLabel}; pass --harness ${owners.join(" or --harness ")}`,
    );
  }
  return { receivers: declaring };
}

interface AddTarget {
  mode: "global" | "project";
  plan: BuiltPlan;
  /** Root that owns the pack: the Source Repository or the project. */
  sourceRoot: string;
  packName: string;
  packDirectory: string;
  scope: string;
  scopeLabel: string;
  harnesses: HarnessName[];
  rebuild: () => Promise<BuiltPlan>;
  /** Regenerate this machine's artifacts through the ordinary generate path. */
  regenerate: () => Promise<void>;
}

function requireSelectedHarness(harness: HarnessName | undefined, selected: readonly HarnessName[], scopeLabel: string): void {
  if (harness !== undefined && !selected.includes(harness)) {
    throw new AgentsmithError("config", `Harness ${harness} is not selected by ${scopeLabel} (selected: ${selected.join(", ")})`);
  }
}

async function globalTarget(options: AddOptions): Promise<AddTarget> {
  const configOption = options.config ?? MACHINE_CONFIG_PATH;
  const configPath = resolveConfiguredPath(configOption, resolve(process.cwd(), "config.toml"));
  const machine = await classify("config", () => loadMachineConfig(configPath));
  const profile = await classify("config", () => loadProfileConfig(machine.source, machine.profile));
  const scopeLabel = `profile ${machine.profile}`;
  requireSelectedHarness(options.harness, profile.harnesses, scopeLabel);
  if (options.pack !== undefined && parseSourceId(options.pack).owner === "project") {
    throw new AgentsmithError("config", "global add cannot target a project pack");
  }
  const packName = choosePack(profile.packs, options.pack, `selected by ${scopeLabel}`);
  const packDirectory = join(machine.source, "packs", ...packName.split("/"));
  if (!existsSync(packDirectory)) throw new AgentsmithError("config", `Pack directory does not exist: ${packDirectory}`);
  const rebuild = () => classify("config", () => buildGlobalPlan(configOption));
  return {
    mode: "global",
    plan: await rebuild(),
    sourceRoot: machine.source,
    packName,
    packDirectory,
    scope: "<global>",
    scopeLabel,
    harnesses: profile.harnesses,
    rebuild,
    regenerate: () => runRecordedGlobal("generate", { config: options.config }),
  };
}

function normalizeScope(value: string): string {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}

async function projectTarget(options: AddOptions): Promise<AddTarget> {
  if (options.push) throw new AgentsmithError("config", "--push is only supported by global add");
  if (options.noCommit) throw new AgentsmithError("config", "--no-commit is only supported by global add; project add never commits");
  if (options.local) throw new AgentsmithError("config", "--local is only supported by global add");
  const start = options.project ?? process.cwd();
  const configPath = await classify("config", () => discoverProjectConfig(start));
  const project = await classify("config", () => loadProjectConfig(configPath));
  const rebuild = () => classify("config", () => buildProjectPlan(start, options.config ?? MACHINE_CONFIG_PATH));
  const plan = await rebuild();
  const projectRoot = plan.projectRoot!;

  let scopePath: string;
  if (options.scope !== undefined) {
    scopePath = normalizeScope(options.scope);
    if (!project.scopes.some((scope) => scope.path === scopePath)) {
      throw new AgentsmithError("config", `Scope ${scopePath} is not declared (scopes: ${project.scopes.map((scope) => scope.path).join(", ")})`);
    }
  } else {
    const cwd = relative(projectRoot, canonicalRoot(process.cwd())).replaceAll("\\", "/");
    const inside = cwd === "" ? "." : cwd;
    const containing = project.scopes
      .filter((scope) => !inside.startsWith("..") && (scope.path === "." || inside === scope.path || inside.startsWith(`${scope.path}/`)))
      .sort((a, b) => b.path.length - a.path.length);
    scopePath = containing[0]?.path ?? ".";
  }
  const scope = project.scopes.find((item) => item.path === scopePath)!;
  const scopeLabel = `scope ${scopePath}`;
  const harnesses = scope.harnesses ?? project.harnesses;
  requireSelectedHarness(options.harness, harnesses, scopeLabel);

  const packsRoot = join(projectSourceRoot(projectRoot), "packs");
  const owned = scope.packs.filter((selection) => {
    const id = parseSourceId(selection);
    return id.owner !== "source" && existsSync(join(packsRoot, ...id.name.split("/")));
  });
  if (options.pack !== undefined && parseSourceId(options.pack).owner === "source") {
    throw new AgentsmithError("config", "project add writes only to project packs");
  }
  const packName = choosePack(owned, options.pack, `owned by the project and selected by ${scopeLabel}`);
  return {
    mode: "project",
    plan,
    sourceRoot: projectRoot,
    packName,
    packDirectory: join(packsRoot, ...packName.split("/")),
    scope: scopePath,
    scopeLabel,
    harnesses,
    rebuild,
    regenerate: async () => generateProject(await rebuild()),
  };
}

function slotDirectory(packDirectory: string, options: AddOptions): string {
  if (options.skillSlot) {
    return options.harness === undefined
      ? join(packDirectory, "skill-slots", options.slot)
      : join(packDirectory, "skill-slots", "harnesses", options.harness, options.slot);
  }
  return options.harness === undefined ? join(packDirectory, "instructions", options.slot) : join(packDirectory, "instructions", options.harness, options.slot);
}

function validateSlotName(options: AddOptions): void {
  if (!validLogicalName(options.slot) || options.slot.includes("/")) {
    throw new AgentsmithError("config", `Invalid slot name ${JSON.stringify(options.slot)}; a snippet slot is one path segment`);
  }
  // Common snippets cannot live in a directory that the layout reserves for harness-specific snippets.
  const reserved = options.skillSlot ? options.slot === "harnesses" : (HARNESS_NAMES as readonly string[]).includes(options.slot);
  if (reserved && options.harness === undefined) {
    throw new AgentsmithError("config", `Slot name ${options.slot} collides with the harness-specific directory layout; pass --harness`);
  }
}

/** The directories `mkdir -p` would create for `directory`, outermost first. */
function missingDirectories(directory: string): string[] {
  const missing: string[] = [];
  let current = resolve(directory);
  while (!existsSync(current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

async function removeSnippet(path: string, created: readonly string[]): Promise<void> {
  await rm(path, { force: true });
  for (const directory of [...created].reverse()) await rmdir(directory).catch(() => undefined);
}

function renders(plan: BuiltPlan, path: string): boolean {
  const target = resolve(path);
  return plan.writes.some((write) => write.provenance.some((item) => resolve(item) === target));
}

/**
 * Write a new snippet into a pack slot, lint the result, and regenerate. A global snippet that is not `--local` is
 * committed (only the new file) unless `--no-commit`; `--push` first fast-forwards a clean Source Repository and then
 * pushes the commit.
 */
export async function addSnippet(mode: "global" | "project", options: AddOptions): Promise<void> {
  validateSlotName(options);
  if (options.push && options.local) throw new AgentsmithError("config", "--push cannot be combined with --local; local snippets are never committed");
  if (options.push && options.noCommit) throw new AgentsmithError("config", "--push cannot be combined with --no-commit");
  const content = await snippetContent(options);
  const target = mode === "global" ? await globalTarget(options) : await projectTarget(options);

  if (options.push && !options.dryRun) {
    await gitPullFfOnly(target.sourceRoot);
    target.plan = await target.rebuild();
  }
  await classify("config", () => assertPlanValid(target.plan));
  const { receivers } = resolveSlot(target.plan, { ...options, scope: target.scope, scopeLabel: target.scopeLabel });

  const directory = slotDirectory(target.packDirectory, options);
  const entries = existsSync(directory) ? await readdir(directory) : [];
  const choice = chooseSnippetNumber(entries, options.placement ?? "gap");
  const path = join(directory, snippetFileName(choice.number, snippetSlug(content, options.name), options.local));
  if (existsSync(path)) throw new AgentsmithError("config", `Refusing to overwrite ${path}`);
  if (options.local && !(await gitIsIgnored(target.sourceRoot, path))) {
    throw new AgentsmithError(
      "config",
      `Refusing to write ${path}: it is not ignored by Git in the Source Repository, so it would block global sync. Ignore *.local.md in the Source Repository's .gitignore.`,
    );
  }

  console.log(`${options.dryRun ? "Would add" : "Adding"} ${path}`);
  console.log(`  pack ${target.packName}, ${options.skillSlot ? "skill slot" : "slot"} ${options.slot}${options.harness ? ` for ${options.harness}` : ""}`);
  console.log(`  number ${two(choice.number)}: ${choice.reason}`);
  if (options.skillSlot) console.log(`  receiving skills: ${[...new Set(receivers.map((item) => describeTarget(item, target.mode)))].join(", ")}`);
  if (options.dryRun) {
    process.stdout.write(`\n${content}`);
    return;
  }

  const created = missingDirectories(directory);
  await mkdir(directory, { recursive: true });
  await atomicWrite(path, new TextEncoder().encode(content));
  try {
    const linted = await target.rebuild();
    await classify("config", () => assertPlanValid(linted));
    if (!renders(linted, path)) throw new AgentsmithError("config", `The snippet does not render into any artifact: ${path}`);
  } catch (cause) {
    await removeSnippet(path, created);
    throw new AgentsmithError(errorCode(cause) === "failure" ? "config" : errorCode(cause), `Lint failed; removed ${path}:\n${errorMessage(cause)}`, {
      cause,
    });
  }

  // An uncommitted file in the Source Repository blocks every later global sync, so a shared global snippet is
  // committed unless the user opts out.
  if (target.mode === "global" && !options.local && !options.noCommit) {
    await commitSnippet(target.sourceRoot, path, created, { push: options.push === true });
  } else if (target.mode === "global" && options.noCommit) {
    console.log(`  not committed: commit and push it in ${target.sourceRoot} before the next global sync, which refuses a dirty Source Repository`);
  }

  if (options.skipGenerate) {
    console.log(`Added ${path}; skipped regeneration.`);
    return;
  }
  try {
    await target.regenerate();
  } catch (cause) {
    throw new AgentsmithError(errorCode(cause), `Added ${path}, but regeneration failed; the snippet was kept:\n${errorMessage(cause)}`, { cause });
  }
  console.log(`Added ${path}.`);
}

async function commitSnippet(sourceRoot: string, path: string, created: readonly string[], options: { push: boolean }): Promise<void> {
  const relativePath = relative(sourceRoot, path).split(sep).join("/");
  try {
    await runCommand("git", ["add", "--", relativePath], { cwd: sourceRoot });
    await runCommand("git", ["commit", "-q", "-m", `Add snippet ${relativePath}`, "--", relativePath], { cwd: sourceRoot });
  } catch (cause) {
    await runCommand("git", ["reset", "-q", "--", relativePath], { cwd: sourceRoot, allowFailure: true }).catch(() => undefined);
    await removeSnippet(path, created);
    throw new AgentsmithError("failure", `Could not commit ${relativePath}; removed it:\n${errorMessage(cause)}`, { cause });
  }
  const commit = await gitHeadCommit(sourceRoot);
  if (!options.push) {
    console.log(
      `  committed ${commit ?? relativePath}, not pushed: push it with \`git -C ${sourceRoot} push\` (or use --push); once another machine pushes, the next global sync cannot fast-forward`,
    );
    return;
  }
  try {
    await runCommand("git", ["push", "-q"], { cwd: sourceRoot, timeoutMs: 120_000 });
  } catch (cause) {
    throw new AgentsmithError(
      "failure",
      `Committed ${relativePath} as ${commit ?? "a local commit"} but the push failed; the commit is kept. Push it with \`git -C ${sourceRoot} push\`, then run \`asmith global generate\`.\n${errorMessage(cause)}`,
      { cause },
    );
  }
  console.log(`  committed ${commit ?? relativePath} and pushed`);
}
