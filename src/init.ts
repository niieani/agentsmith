import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";
import { diagnosticsText, prepareGlobalPlan, runRecordedGlobal } from "./commands.ts";
import { loadProfileConfig, MACHINE_CONFIG_PATH, profileConfigPath, resolveConfiguredPath } from "./config.ts";
import { AgentsmithError, classify, errorMessage } from "./errors.ts";
import { walkFiles } from "./fs.ts";
import { gitWorktree, runCommand } from "./git.ts";
import { assertPlanValid, buildGlobalPlan } from "./planner.ts";
import { atomicWrite, type GlobalConflict, preflightGlobalPlan, unifiedDiff } from "./safety.ts";
import { installSchedule, intervalSeconds, shellCommand } from "./schedule.ts";

export const DEFAULT_SOURCE_PATH = "~/.agents/agentsmith/source";

export interface InitOptions {
  url: string;
  profile: string;
  source?: string;
  config?: string;
  schedule?: boolean;
  interval?: string;
  yes?: boolean;
}

export interface InitDependencies {
  /** Whether a person can answer a prompt. */
  interactive?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  installSchedule?: typeof installSchedule;
}

async function confirmOnTerminal(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

/** A comparable form of a Git remote URL: local paths are canonicalized; trailing slashes and `.git` are ignored. */
export function normalizeRemote(url: string, base = process.cwd()): string {
  let value = url.trim();
  if (value.startsWith("file://")) value = fileURLToPath(value);
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  const isScp = !isUrl && /^[^/]+:/.test(value);
  if (!isUrl && !isScp) {
    value = resolveConfiguredPath(value, join(base, ".remote"));
    try {
      value = realpathSync(value);
    } catch {
      // A remote path that does not exist locally is compared as written.
    }
  }
  return value.replace(/\/+$/, "").replace(/\.git$/, "");
}

async function cloneOrReuseSource(url: string, source: string): Promise<void> {
  const exists = existsSync(source);
  if (exists && !lstatSync(source).isDirectory()) throw new AgentsmithError("config", `Source path exists and is not a directory: ${source}`);
  if (exists && readdirSync(source).length > 0) {
    const worktree = await classify("config", () => gitWorktree(source)).catch((cause: unknown) => {
      throw new AgentsmithError("config", `Source path exists but is not a Git worktree: ${source} (${errorMessage(cause)})`);
    });
    if (realpathSync(worktree.root) !== realpathSync(source)) {
      throw new AgentsmithError("config", `Source path exists but is not the root of a Git worktree: ${source} (inside ${worktree.root})`);
    }
    const remotes = await runCommand("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { cwd: source, allowFailure: true });
    const urls = remotes.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 2)[1])
      .filter((value): value is string => value !== undefined);
    const wanted = normalizeRemote(url);
    if (!urls.some((candidate) => normalizeRemote(candidate, source) === wanted)) {
      throw new AgentsmithError(
        "config",
        `Source path ${source} is a clone of a different repository (${urls.join(", ") || "no remotes"}), not ${url}. Choose another --source or remove it.`,
      );
    }
    console.log(`Reusing existing clone at ${source}`);
    return;
  }
  await mkdir(dirname(source), { recursive: true });
  console.log(`Cloning ${url} into ${source}`);
  await classify("source-pull", () => runCommand("git", ["clone", "--", url, source]));
}

async function availableProfiles(source: string): Promise<string[]> {
  const root = join(source, "profiles");
  if (!existsSync(root)) return [];
  return (await walkFiles(root).catch(() => []))
    .map((file) => file.relativePath.replaceAll("\\", "/"))
    .filter((path) => path.endsWith(".toml"))
    .map((path) => path.slice(0, -".toml".length))
    .sort();
}

async function verifyProfile(source: string, profile: string): Promise<void> {
  const available = async () => {
    const names = await availableProfiles(source);
    return `Available profiles: ${names.join(", ") || "(none)"}`;
  };
  let path: string;
  try {
    path = profileConfigPath(source, profile);
  } catch (cause) {
    throw new AgentsmithError("config", `Invalid profile ${JSON.stringify(profile)}: ${errorMessage(cause)}\n${await available()}`);
  }
  if (!existsSync(path))
    throw new AgentsmithError("config", `Profile ${JSON.stringify(profile)} not found in ${join(source, "profiles")}.\n${await available()}`);
  try {
    loadProfileConfig(source, profile);
  } catch (cause) {
    throw new AgentsmithError("config", `Profile ${JSON.stringify(profile)} does not resolve: ${errorMessage(cause)}\n${await available()}`);
  }
}

/** Whether an existing machine config selects something else; undefined when there is none. */
function existingMachineConfig(configPath: string): { source?: string; profile?: string; raw: string } | undefined {
  if (!existsSync(configPath)) return undefined;
  const raw = readFileSync(configPath, "utf8");
  try {
    const value = parse(raw) as Record<string, unknown>;
    return {
      raw,
      source: typeof value.source === "string" ? resolveConfiguredPath(value.source, configPath) : undefined,
      profile: typeof value.profile === "string" ? value.profile : undefined,
    };
  } catch {
    return { raw };
  }
}

function rerunCommand(options: InitOptions): string {
  return shellCommand([
    "asmith",
    "global",
    "init",
    options.url,
    "--profile",
    options.profile,
    ...(options.source === undefined ? [] : ["--source", options.source]),
    ...(options.config === undefined ? [] : ["--config", options.config]),
    ...(options.schedule ? ["--schedule"] : []),
    ...(options.interval === undefined ? [] : ["--interval", options.interval]),
    "--yes",
  ]);
}

async function describeConflict(conflict: GlobalConflict, planned: Uint8Array | undefined): Promise<string> {
  const label = conflict.reason === "unrecorded" ? "existing file not written by agentsmith" : "locally modified file";
  if (!existsSync(conflict.destination) || lstatSync(conflict.destination).isDirectory()) return `${label}: ${conflict.destination}\n`;
  const before = new TextDecoder().decode(await readFile(conflict.destination));
  const after = planned === undefined ? "" : new TextDecoder().decode(planned);
  return `${label}: ${conflict.destination}\n${unifiedDiff(before, after, conflict.destination)}`;
}

/**
 * Bootstrap a machine: clone the Source Repository, select a profile, lint,
 * preview the first sync, reconcile existing artifacts, sync, and optionally
 * schedule future syncs.
 */
export async function globalInit(options: InitOptions, dependencies: InitDependencies = {}): Promise<void> {
  const cwd = process.cwd();
  const source = resolveConfiguredPath(options.source ?? DEFAULT_SOURCE_PATH, join(cwd, ".source"));
  const configPath = resolveConfiguredPath(options.config ?? MACHINE_CONFIG_PATH, join(cwd, "config.toml"));
  if (options.interval !== undefined && !options.schedule) throw new AgentsmithError("config", "--interval requires --schedule");
  if (options.schedule) {
    intervalSeconds(options.interval);
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new AgentsmithError("failure", `Scheduling is supported on macOS and Linux, not on ${process.platform}; rerun without --schedule`);
    }
  }

  const existing = existingMachineConfig(configPath);
  const unchanged = existing !== undefined && existing.profile === options.profile && existing.source === source;
  if (existing !== undefined && !unchanged && !options.yes) {
    const current = existing.profile === undefined ? "unreadable content" : `source ${existing.source ?? "(unset)"}, profile ${existing.profile}`;
    throw new AgentsmithError(
      "config",
      `Machine config ${configPath} already exists with ${current}. Rerun with --yes to replace it:\n  ${rerunCommand(options)}`,
    );
  }

  await cloneOrReuseSource(options.url, source);
  await verifyProfile(source, options.profile);

  if (!unchanged) {
    await mkdir(dirname(configPath), { recursive: true });
    await atomicWrite(configPath, new TextEncoder().encode(stringify({ source, profile: options.profile })));
    console.log(`${existing === undefined ? "Wrote" : "Replaced"} machine config ${configPath} (profile ${options.profile})`);
  } else {
    console.log(`Machine config ${configPath} already selects profile ${options.profile}`);
  }

  const plan = await classify("config", () => buildGlobalPlan(configPath));
  if (plan.diagnostics.length > 0) console.error(diagnosticsText(plan.diagnostics));
  await classify("config", () => assertPlanValid(plan));
  console.log(`Lint passed with ${plan.diagnostics.filter((item) => item.severity === "warning").length} warning(s).`);

  const prepared = await prepareGlobalPlan(plan);
  const conflicts = await preflightGlobalPlan(plan, { state: prepared.previous, onModified: "backup" });
  const conflicting = new Map(conflicts.map((conflict) => [conflict.destination, conflict]));
  const lines: string[] = [];
  for (const write of plan.writes) {
    const destination = resolve(write.destination);
    const conflict = conflicting.get(destination);
    let action = "create";
    if (conflict) action = conflict.reason === "unrecorded" ? "replace unrecorded" : "replace modified";
    else if (existsSync(destination) && lstatSync(destination).isFile()) {
      action = Buffer.from(await readFile(destination)).equals(Buffer.from(write.content)) ? "unchanged" : "update";
    }
    lines.push(`  ${action.padEnd(18)} ${destination}`);
  }
  for (const deletion of plan.deletes) lines.push(`  ${"remove".padEnd(18)} ${deletion.destination}`);
  console.log(`First sync will write ${plan.writes.length} file(s) and remove ${plan.deletes.length}:`);
  if (lines.length > 0) console.log(lines.join("\n"));

  let onModified: "fail" | "backup" = "fail";
  if (conflicts.length > 0) {
    const contents = new Map(plan.writes.map((write) => [resolve(write.destination), write.content]));
    const details = await Promise.all(conflicts.map((conflict) => describeConflict(conflict, contents.get(conflict.destination))));
    const summary = `${conflicts.length} existing global artifact(s) must be adopted; each is moved aside as a backup and replaced (--on-modified=backup).`;
    if (options.yes) {
      console.log(summary);
      onModified = "backup";
    } else if (dependencies.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)) {
      process.stdout.write(details.join(""));
      console.log(summary);
      if (!(await (dependencies.confirm ?? confirmOnTerminal)("Back up and replace these files?"))) {
        throw new AgentsmithError("artifact-modified", `Stopped before the first sync. To adopt the files later, rerun:\n  ${rerunCommand(options)}`);
      }
      onModified = "backup";
    } else {
      console.error(details.join(""));
      throw new AgentsmithError(
        "artifact-modified",
        `${summary}\nRefusing to replace them without confirmation. Inspect the diff above, then rerun:\n  ${rerunCommand(options)}`,
      );
    }
  }

  await runRecordedGlobal("sync", { config: configPath, onModified });

  if (options.schedule) {
    await (dependencies.installSchedule ?? installSchedule)({ interval: options.interval, config: options.config === undefined ? undefined : configPath });
  } else {
    console.log("Next: keep this machine converged with `asmith global schedule install`.");
  }
}
