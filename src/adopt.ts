import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { choosePack } from "./add.ts";
import { generateGlobal } from "./commands.ts";
import { loadMachineConfig, loadProfileConfig, MACHINE_CONFIG_PATH, parseSourceId, resolveConfiguredPath } from "./config.ts";
import { AgentsmithError, classify } from "./errors.ts";
import { gitIsIgnored } from "./git.ts";
import { RESERVED_EDGE_SLOTS, validLogicalName } from "./markdown.ts";
import { assertPlanValid, buildGlobalPlan } from "./planner.ts";
import { atomicWrite, globalBlobDirectory, globalStatePath, hashBytes, loadGlobalState, readBlob } from "./safety.ts";
import type { HarnessName } from "./types.ts";

/**
 * File names of the snippets that accumulate adopted edits in one slot. The
 * prefix file sorts before, and the suffix file after, conventionally numbered
 * snippets in the same directory.
 */
export const ADOPTED_PREFIX_SNIPPET = "00-adopted.local.md";
export const ADOPTED_SUFFIX_SNIPPET = "99-adopted.local.md";

export interface AdoptOptions {
  config?: string;
  slot?: string;
  pack?: string;
  dryRun?: boolean;
}

/**
 * Split an edited artifact around its last generated content. Only edits made
 * strictly before or after the generated content are adoptable; any other
 * change returns undefined.
 */
export function splitAroundGenerated(current: string, generated: string): { prefix: string; suffix: string } | undefined {
  const index = current.indexOf(generated);
  if (index < 0) return undefined;
  return { prefix: current.slice(0, index), suffix: current.slice(index + generated.length) };
}

interface Adoption {
  destination: string;
  harness: HarnessName;
  prefix: string;
  suffix: string;
}

interface SnippetWrite {
  path: string;
  /** Text added before existing content (prepend slot) or after it (other slots). */
  before: string;
  after: string;
}

function snippetWrites(adoptions: Adoption[], packDirectory: string, slot: string | undefined): SnippetWrite[] {
  const writes = new Map<string, SnippetWrite>();
  const add = (harness: HarnessName, slotName: string, before: string, after: string) => {
    if (!before && !after) return;
    const name = slotName === "prepend" ? ADOPTED_PREFIX_SNIPPET : ADOPTED_SUFFIX_SNIPPET;
    const path = join(packDirectory, "instructions", harness, ...slotName.split("/"), name);
    const existing = writes.get(path) ?? { path, before: "", after: "" };
    // A newer prefix belongs in front of older adopted prefixes; a newer suffix after older suffixes.
    existing.before = before + existing.before;
    existing.after += after;
    writes.set(path, existing);
  };
  for (const adoption of adoptions) {
    if (slot === undefined) {
      add(adoption.harness, "prepend", adoption.prefix, "");
      add(adoption.harness, "append", "", adoption.suffix);
    } else {
      add(adoption.harness, slot, "", adoption.prefix + adoption.suffix);
    }
  }
  return [...writes.values()];
}

function describe(text: string): string {
  const lines = text.replace(/\n$/, "").split("\n").length;
  return `${new TextEncoder().encode(text).byteLength} bytes, ${lines} line(s)`;
}

/**
 * Turn local edits made strictly before or after generated global instruction
 * content into ignored `*.local.md` snippets, then regenerate so state records
 * the adopted result.
 */
export async function adoptGlobal(options: AdoptOptions): Promise<void> {
  const configOption = options.config ?? MACHINE_CONFIG_PATH;
  const configPath = resolveConfiguredPath(configOption, resolve(process.cwd(), "config.toml"));
  const machine = await classify("config", () => loadMachineConfig(configPath));
  const profile = await classify("config", () => loadProfileConfig(machine.source, machine.profile));

  if (options.slot !== undefined) {
    if (!validLogicalName(options.slot)) throw new AgentsmithError("config", `Invalid slot name ${JSON.stringify(options.slot)}`);
  }
  if (options.pack !== undefined && (await classify("config", () => parseSourceId(options.pack!))).owner === "project") {
    throw new AgentsmithError("config", "Global adoption cannot target a project pack");
  }
  const pack = { name: choosePack(profile.packs, options.pack, `selected by profile ${machine.profile}`) };
  const packDirectory = join(machine.source, "packs", ...pack.name.split("/"));
  if (!existsSync(packDirectory)) throw new AgentsmithError("config", `Pack directory does not exist: ${packDirectory}`);

  const plan = await classify("config", () => buildGlobalPlan(configOption));
  await classify("config", () => assertPlanValid(plan));
  const statePath = globalStatePath();
  const state = await loadGlobalState(statePath);
  const blobs = globalBlobDirectory(statePath);
  const instructions = new Map(
    plan.writes.filter((write) => write.kind === "instruction").map((write) => [resolve(write.destination), write.harness!] as const),
  );
  const skills = new Set(plan.writes.filter((write) => write.kind === "skill").map((write) => resolve(write.destination)));

  const adoptions: Adoption[] = [];
  const refusals: string[] = [];
  const candidates = new Set([...Object.keys(state.artifacts).map((path) => resolve(path)), ...instructions.keys()]);
  for (const destination of [...candidates].sort()) {
    if (!existsSync(destination)) continue;
    const recorded = state.artifacts[destination];
    const current = new Uint8Array(await readFile(destination));
    if (recorded !== undefined && hashBytes(current) === recorded) continue;
    const harness = instructions.get(destination);
    if (skills.has(destination)) {
      refusals.push(`${destination}: skill artifacts are never adopted; move the edit into the Source Repository or back it up with --on-modified=backup`);
    } else if (harness === undefined) {
      refusals.push(`${destination}: no longer generated by the active profile; resolve it by hand`);
    } else if (recorded === undefined) {
      refusals.push(`${destination}: unrecorded artifact has no stored generated content to compare against`);
    } else {
      const stored = await readBlob(blobs, recorded);
      if (stored === undefined) {
        refusals.push(`${destination}: no stored generated content exists for this artifact; run global generate once with this version first`);
        continue;
      }
      const split = splitAroundGenerated(new TextDecoder().decode(current), new TextDecoder().decode(stored));
      if (!split) {
        refusals.push(`${destination}: edits are not strictly before or after the generated content; resolve them by hand`);
        continue;
      }
      adoptions.push({ destination, harness, ...split });
    }
  }
  if (refusals.length > 0) {
    throw new AgentsmithError(
      "artifact-modified",
      `Refusing to adopt global artifacts; nothing was changed:\n${refusals.map((item) => `  ${item}`).join("\n")}`,
    );
  }
  if (adoptions.length === 0) {
    console.log("No modified global instruction artifacts to adopt.");
    return;
  }

  const writes = snippetWrites(adoptions, packDirectory, options.slot);
  for (const write of writes) {
    if (!(await gitIsIgnored(machine.source, write.path))) {
      throw new AgentsmithError(
        "config",
        `Refusing to write ${write.path}: it is not ignored by Git in the Source Repository, so it would block global sync. Ignore *.local.md in the Source Repository's .gitignore.`,
      );
    }
  }

  for (const adoption of adoptions) {
    const parts = [
      adoption.prefix ? `prefix (${describe(adoption.prefix)})` : undefined,
      adoption.suffix ? `suffix (${describe(adoption.suffix)})` : undefined,
    ].filter(Boolean);
    console.log(`${options.dryRun ? "Would adopt" : "Adopting"} ${adoption.destination}: ${parts.join(" and ")}`);
  }
  for (const write of writes) console.log(`  ${options.dryRun ? "would write" : "writing"} ${write.path}`);
  if (options.dryRun) return;

  const previous = new Map<string, string | undefined>();
  for (const write of writes) previous.set(write.path, existsSync(write.path) ? await readFile(write.path, "utf8") : undefined);
  try {
    for (const write of writes) {
      await atomicWrite(write.path, new TextEncoder().encode(write.before + (previous.get(write.path) ?? "") + write.after));
    }
    const regenerated = await classify("config", () => buildGlobalPlan(configOption));
    await classify("config", () => assertPlanValid(regenerated));
    for (const adoption of adoptions) {
      const write = regenerated.writes.find((item) => resolve(item.destination) === adoption.destination);
      const content = write ? new TextDecoder().decode(write.content) : "";
      for (const part of [adoption.prefix, adoption.suffix].map((text) => text.trim()).filter(Boolean)) {
        if (!content.includes(part)) throw new Error(`Adopted text does not render into ${adoption.destination}; check that the slot exists in its template`);
      }
    }
    await generateGlobal(regenerated, { accept: new Set(adoptions.map((adoption) => adoption.destination)) });
  } catch (cause) {
    for (const [path, content] of previous) {
      if (content === undefined) await rm(path, { force: true }).catch(() => undefined);
      else await atomicWrite(path, new TextEncoder().encode(content)).catch(() => undefined);
    }
    throw cause;
  }
  const slots = options.slot ?? RESERVED_EDGE_SLOTS.join("/");
  console.log(`Adopted ${adoptions.length} artifact(s) into pack ${pack.name} (${slots}).`);
}
