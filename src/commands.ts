import { existsSync } from "node:fs";
import { readFile, rmdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { stringify } from "smol-toml";
import { loadMachineConfig, MACHINE_CONFIG_PATH, resolveConfiguredPath } from "./config.ts";
import { CommandError, ensureCleanSource, gitPullFfOnly, gitWorktree } from "./git.ts";
import {
  assertPlanValid,
  buildGlobalPlan,
  buildProjectPlan,
  type BuiltPlan,
} from "./planner.ts";
import {
  applyPlan,
  globalStatePath,
  hashBytes,
  loadGlobalState,
  loadProjectState,
  preflightGlobalPlan,
  preflightProjectPlan,
  projectStatePath,
  unifiedDiff,
  type GlobalState,
  type ProjectState,
} from "./safety.ts";
import type { Diagnostic, GenerationPlan, PlannedDelete, PlannedWrite } from "./types.ts";

const encoder = new TextEncoder();

export interface CommandOptions {
  config?: string;
  project?: string;
  force?: boolean;
  json?: boolean;
  warningsAsErrors?: boolean;
}

function diagnosticsText(diagnostics: Diagnostic[]): string {
  return diagnostics.map((item) => {
    const location = item.path ? ` (${item.path})` : "";
    return `${item.severity.toUpperCase()} ${item.code}: ${item.message}${location}`;
  }).join("\n");
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  if (diagnostics.length > 0) console.error(diagnosticsText(diagnostics));
}

function relativeStatePath(root: string, path: string): string {
  return relative(root, resolve(path)).replaceAll("\\", "/");
}

async function prepareProjectPlan(plan: BuiltPlan): Promise<{
  worktree: Awaited<ReturnType<typeof gitWorktree>>;
  statePath: string;
  previous: ProjectState;
}> {
  const worktree = await gitWorktree(plan.projectRoot!);
  const statePath = projectStatePath(worktree);
  const previous = await loadProjectState(statePath);
  const current = new Set(plan.plannedPaths.map((path) => relativeStatePath(worktree.root, path)));
  plan.deletes = previous.paths
    .filter((path) => !current.has(path))
    .map((path): PlannedDelete => ({ destination: resolve(worktree.root, path), kind: "skill" }));
  return { worktree, statePath, previous };
}

async function prepareGlobalPlan(plan: BuiltPlan): Promise<{
  statePath: string;
  previous: GlobalState;
}> {
  const statePath = globalStatePath();
  const previous = await loadGlobalState(statePath);
  const current = new Set(plan.plannedPaths.map((path) => resolve(path)));
  plan.deletes = Object.keys(previous.artifacts)
    .filter((path) => !current.has(resolve(path)))
    .map((path): PlannedDelete => ({ destination: path, kind: "skill" }));
  return { statePath, previous };
}

function projectStateWrite(statePath: string, root: string, plan: BuiltPlan): PlannedWrite {
  const state = {
    version: 1,
    paths: [...new Set(plan.plannedPaths.map((path) => relativeStatePath(root, path)))].sort(),
  };
  return {
    destination: statePath,
    content: encoder.encode(stringify(state)),
    kind: "state",
    provenance: [plan.configPath],
  };
}

function globalStateWrite(statePath: string, plan: BuiltPlan): PlannedWrite {
  const entries: Array<[string, string]> = plan.writes
      .filter((write) => write.kind !== "state")
      .map((write) => [resolve(write.destination), hashBytes(write.content)] as [string, string]);
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const artifacts = Object.fromEntries(entries);
  return {
    destination: statePath,
    content: encoder.encode(stringify({ version: 1, artifacts })),
    kind: "state",
    provenance: [plan.configPath],
  };
}

async function pruneEmptySkillDirectories(deletions: PlannedDelete[]): Promise<void> {
  for (const deletion of deletions) {
    const normalized = resolve(deletion.destination);
    const markers = [`${sep}.agents${sep}skills${sep}`, `${sep}.claude${sep}skills${sep}`];
    const marker = markers.find((candidate) => normalized.includes(candidate));
    if (!marker) continue;
    const markerIndex = normalized.indexOf(marker);
    const skillRoot = normalized.slice(0, markerIndex + marker.length - 1);
    let current = dirname(normalized);
    while (current === skillRoot || current.startsWith(`${skillRoot}${sep}`)) {
      try {
        await rmdir(current);
      } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || (cause.code !== "ENOENT" && cause.code !== "ENOTEMPTY")) {
          console.error(`WARNING stale-directory-cleanup: could not remove empty directory ${current}: ${cause instanceof Error ? cause.message : String(cause)}`);
          break;
        }
        if (cause instanceof Error && "code" in cause && cause.code === "ENOTEMPTY") break;
      }
      if (current === skillRoot) break;
      current = dirname(current);
    }
  }
}

async function generate(plan: BuiltPlan, options: CommandOptions): Promise<void> {
  assertPlanValid(plan);
  printDiagnostics(plan.diagnostics.filter((item) => item.severity === "warning"));
  if (plan.mode === "project") {
    const prepared = await prepareProjectPlan(plan);
    await preflightProjectPlan(plan, { projectRoot: plan.projectRoot!, state: prepared.previous });
    const application: GenerationPlan = {
      ...plan,
      writes: [...plan.writes, projectStateWrite(prepared.statePath, prepared.worktree.root, plan)],
    };
    await applyPlan(application);
    await pruneEmptySkillDirectories(plan.deletes);
  } else {
    const prepared = await prepareGlobalPlan(plan);
    await preflightGlobalPlan(plan, { state: prepared.previous, force: options.force });
    const application: GenerationPlan = {
      ...plan,
      writes: [...plan.writes, globalStateWrite(prepared.statePath, plan)],
    };
    await applyPlan(application);
    await pruneEmptySkillDirectories(plan.deletes);
  }
  console.log(`Generated ${plan.writes.length} file(s); removed ${plan.deletes.length} stale file(s).`);
}

async function diffPlan(plan: BuiltPlan): Promise<void> {
  if (plan.mode === "project") {
    try {
      await prepareProjectPlan(plan);
    } catch (cause) {
      const unavailable = cause instanceof CommandError && /not a git repository/i.test(`${cause.result.stderr}\n${cause.result.stdout}`);
      if (!unavailable) throw cause;
      plan.diagnostics.push({
        severity: "warning",
        code: "project-diff-without-git-state",
        message: `Stale artifact deletions were not included because Git state is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: plan.projectRoot,
      });
    }
  } else await prepareGlobalPlan(plan);
  assertPlanValid(plan);
  printDiagnostics(plan.diagnostics);
  let output = "";
  for (const write of plan.writes) {
    const before = existsSync(write.destination) ? await readFile(write.destination) : new Uint8Array();
    const markdown = write.destination.endsWith(".md") || write.destination.endsWith(".toml");
    if (markdown) {
      output += unifiedDiff(new TextDecoder().decode(before), new TextDecoder().decode(write.content), write.destination);
    } else if (!Buffer.from(before).equals(Buffer.from(write.content))) {
      output += `Binary file changed: ${write.destination}\n`;
    }
  }
  for (const deletion of plan.deletes) {
    if (!existsSync(deletion.destination)) continue;
    const before = await readFile(deletion.destination);
    if (deletion.destination.endsWith(".md") || deletion.destination.endsWith(".toml")) {
      output += unifiedDiff(new TextDecoder().decode(before), "", deletion.destination);
    } else {
      output += `Binary file deleted: ${deletion.destination}\n`;
    }
  }
  process.stdout.write(output || "No changes.\n");
}

function explainHuman(plan: BuiltPlan): string {
  const explanation = plan.explanation as { artifacts?: Array<Record<string, unknown>> };
  const lines = [
    `${plan.mode} plan`,
    `Config: ${plan.configPath}`,
    ...(plan.sourceRoot ? [`Source Repository: ${plan.sourceRoot}`] : []),
    ...(plan.projectRoot ? [`Project: ${plan.projectRoot}`] : []),
    "",
  ];
  for (const artifact of explanation.artifacts ?? []) {
    const label = artifact.kind === "skill" ? `skill ${artifact.name}` : "instruction layer";
    lines.push(`${artifact.harness} ${artifact.scope}: ${label}`);
    lines.push(`  destination: ${artifact.destination}`);
    if (artifact.template) lines.push(`  template: ${artifact.template}`);
    if (Array.isArray(artifact.packs)) lines.push(`  packs: ${artifact.packs.join(", ") || "(none)"}`);
    if (artifact.sourceId) lines.push(`  source: ${artifact.sourceId}`);
    if (typeof artifact.bytes === "number") lines.push(`  bytes: ${artifact.bytes}`);
    if (typeof artifact.markdownBytes === "number") lines.push(`  markdown bytes: ${artifact.markdownBytes}`);
    if (typeof artifact.supportBytes === "number") lines.push(`  support bytes: ${artifact.supportBytes}`);
    if (Array.isArray(artifact.enabledBy)) lines.push(`  enabled by packs: ${artifact.enabledBy.join(", ") || "(explicit)"}`);
    if (artifact.explicitlyEnabled === true) lines.push("  explicitly enabled: yes");
    if (Array.isArray(artifact.scopeExclusions) && artifact.scopeExclusions.length > 0) {
      lines.push(`  scope exclusions: ${artifact.scopeExclusions.join(", ")}`);
    }
    const trace = artifact.trace as { includes?: string[]; slots?: Record<string, string[]> } | undefined;
    if (trace?.includes?.length) lines.push(`  includes: ${trace.includes.join(", ")}`);
    for (const [slot, snippets] of Object.entries(trace?.slots ?? {})) {
      lines.push(`  slot ${slot}: ${snippets.join(", ") || "(empty)"}`);
    }
    if (Array.isArray(artifact.files)) {
      for (const value of artifact.files) {
        const file = value as { path?: string; bytes?: number; supportBytes?: number; trace?: { includes?: string[]; slots?: Record<string, string[]> } };
        lines.push(`  file: ${file.path ?? "(unknown)"}`);
        if (typeof file.bytes === "number") lines.push(`    bytes: ${file.bytes}`);
        if (typeof file.supportBytes === "number") lines.push(`    support bytes: ${file.supportBytes}`);
        if (file.trace?.includes?.length) lines.push(`    includes: ${file.trace.includes.join(", ")}`);
        for (const [slot, snippets] of Object.entries(file.trace?.slots ?? {})) {
          lines.push(`    slot ${slot}: ${snippets.join(", ") || "(empty)"}`);
        }
      }
    }
  }
  if (plan.diagnostics.length > 0) lines.push("", diagnosticsText(plan.diagnostics));
  return `${lines.join("\n")}\n`;
}

async function planFor(mode: "global" | "project", options: CommandOptions): Promise<BuiltPlan> {
  return mode === "global"
    ? buildGlobalPlan(options.config ?? MACHINE_CONFIG_PATH)
    : buildProjectPlan(options.project ?? process.cwd(), options.config ?? MACHINE_CONFIG_PATH);
}

export async function executeCommand(
  mode: "global" | "project",
  action: "sync" | "generate" | "diff" | "lint" | "explain",
  options: CommandOptions,
): Promise<void> {
  if (action === "sync") {
    if (mode !== "global") throw new Error("Project sync is not supported");
    const configPath = options.config ?? MACHINE_CONFIG_PATH;
    const resolved = resolveConfiguredPath(configPath, resolve(process.cwd(), "config.toml"));
    const machine = loadMachineConfig(resolved);
    await ensureCleanSource(machine.source);
    await gitPullFfOnly(machine.source);
  }
  const plan = await planFor(mode, options);
  if (action === "sync" || action === "generate") {
    await generate(plan, options);
  } else if (action === "diff") {
    await diffPlan(plan);
  } else if (action === "lint") {
    printDiagnostics(plan.diagnostics);
    assertPlanValid(plan, options.warningsAsErrors);
    console.log(`Lint passed with ${plan.diagnostics.filter((item) => item.severity === "warning").length} warning(s).`);
  } else {
    assertPlanValid(plan);
    process.stdout.write(options.json ? `${JSON.stringify(plan.explanation, null, 2)}\n` : explainHuman(plan));
  }
}
