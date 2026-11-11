import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { splitAroundGenerated } from "../src/adopt.ts";
import { AgentsmithError, classify, EXIT_CODES, exitCodeFor } from "../src/errors.ts";
import { renderMarkdown } from "../src/markdown.ts";
import {
  backupGlobalArtifacts,
  backupTimestamp,
  blobPath,
  collectBlobs,
  hashBytes,
  preflightGlobalPlan,
  readBlob,
  restoreBackups,
  storeBlobs,
} from "../src/safety.ts";
import { parseDuration } from "../src/status.ts";
import type { GenerationPlan, PlannedWrite } from "../src/types.ts";

const temporary: string[] = [];
const bytes = (value: string) => new TextEncoder().encode(value);
const write = (destination: string, content: string, kind: PlannedWrite["kind"] = "instruction"): PlannedWrite => ({
  destination,
  content: bytes(content),
  kind,
  provenance: ["test"],
});
const plan = (writes: PlannedWrite[], deletes: GenerationPlan["deletes"] = []): GenerationPlan => ({ writes, deletes, diagnostics: [], explanation: {} });

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("splitAroundGenerated", () => {
  const generated = "# Global\n\nShared note.\n";

  test("detects a prefix, a suffix, or both", () => {
    expect(splitAroundGenerated(`Local first.\n\n${generated}`, generated)).toEqual({ prefix: "Local first.\n\n", suffix: "" });
    expect(splitAroundGenerated(`${generated}\nLocal last.\n`, generated)).toEqual({ prefix: "", suffix: "\nLocal last.\n" });
    expect(splitAroundGenerated(`A\n${generated}B\n`, generated)).toEqual({ prefix: "A\n", suffix: "B\n" });
    expect(splitAroundGenerated(generated, generated)).toEqual({ prefix: "", suffix: "" });
  });

  test("rejects edits inside the generated content", () => {
    expect(splitAroundGenerated("# Global\n\nEdited note.\n", generated)).toBeUndefined();
    expect(splitAroundGenerated("# Global\n\nInserted.\n\nShared note.\n", generated)).toBeUndefined();
    expect(splitAroundGenerated("# Global\n", generated)).toBeUndefined();
  });
});

describe("reserved edge slots", () => {
  const contribution = (slot: string, content: string) => ({ pack: "base", slot, path: `packs/base/${slot}.md`, content });

  test("insert prepend and append snippets verbatim around instruction artifacts", async () => {
    const result = await renderMarkdown({
      templatePath: "templates/default.md",
      content: "# Guide\n\n<!-- agentsmith:slot notes -->\n",
      contributions: [contribution("prepend", "Local first.\n\n"), contribution("notes", "Note."), contribution("append", "\nLocal last.\n")],
      edgeSlots: true,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.content).toBe("Local first.\n\n# Guide\n\nNote.\n\nLocal last.\n");
    expect(result.trace.slots.prepend).toEqual(["packs/base/prepend.md"]);
    expect(result.trace.slots.append).toEqual(["packs/base/append.md"]);
  });

  test("reproduce prefix + generated + suffix exactly", async () => {
    const generated = (await renderMarkdown({ templatePath: "t.md", content: "# Guide\n\nBody.\n", edgeSlots: true })).content;
    const edited = `Prefix line.\n\n${generated}\n## Local\n\nSuffix.\n`;
    const split = splitAroundGenerated(edited, generated)!;
    const result = await renderMarkdown({
      templatePath: "t.md",
      content: "# Guide\n\nBody.\n",
      contributions: [contribution("prepend", split.prefix), contribution("append", split.suffix)],
      edgeSlots: true,
    });
    expect(result.content).toBe(edited);
  });

  test("reject templates declaring reserved slots", async () => {
    const result = await renderMarkdown({
      templatePath: "t.md",
      content: "# Guide\n\n<!-- agentsmith:slot prepend -->\n<!-- agentsmith:required-slot append -->\n",
      edgeSlots: true,
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(["slot-reserved", "slot-reserved"]);
  });

  test("are ordinary slots outside instruction artifacts", async () => {
    const result = await renderMarkdown({
      templatePath: "SKILL.md",
      content: "# Skill\n\n<!-- agentsmith:slot append -->\n",
      contributions: [contribution("append", "Extra.")],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.content).toBe("# Skill\n\nExtra.\n");
  });
});

describe("content blobs", () => {
  test("store, read, verify, and collect unreferenced content", async () => {
    const root = await directory("agentsmith-blobs-");
    const blobs = join(root, "blobs");
    const kept = bytes("kept\n");
    const dropped = bytes("dropped\n");
    await storeBlobs(blobs, [kept, dropped, kept]);
    expect((await readdir(blobs)).sort()).toEqual([hashBytes(kept), hashBytes(dropped)].sort());
    expect(new TextDecoder().decode(await readBlob(blobs, hashBytes(kept)))).toBe("kept\n");
    expect(await readBlob(blobs, hashBytes(bytes("never stored")))).toBeUndefined();

    await writeFile(blobPath(blobs, hashBytes(dropped)), "corrupted");
    expect(await readBlob(blobs, hashBytes(dropped))).toBeUndefined();
    await writeFile(join(blobs, "unrelated.txt"), "keep me");

    const removed = await collectBlobs(blobs, { version: 1, artifacts: { [join(root, "AGENTS.md")]: hashBytes(kept) } });
    expect(removed).toEqual([hashBytes(dropped)]);
    expect((await readdir(blobs)).sort()).toEqual([hashBytes(kept), "unrelated.txt"].sort());
  });

  test("reject malformed hashes", () => {
    expect(() => blobPath("/tmp", "../escape")).toThrow("Invalid blob hash");
  });
});

describe("modified artifact backups", () => {
  test("preflight returns conflicts instead of failing in backup mode", async () => {
    const root = await directory("agentsmith-backup-");
    const instruction = join(root, "CLAUDE.md");
    const unrecorded = join(root, "AGENTS.md");
    await writeFile(instruction, "edited\n");
    await writeFile(unrecorded, "mine\n");
    const state = { version: 1 as const, artifacts: { [instruction]: hashBytes(bytes("generated\n")) } };
    const generation = plan([write(instruction, "next\n"), write(unrecorded, "next\n")]);
    await expect(preflightGlobalPlan(generation, { state })).rejects.toBeInstanceOf(AgentsmithError);
    const conflicts = await preflightGlobalPlan(generation, { state, onModified: "backup" });
    expect(conflicts).toEqual([
      { destination: instruction, reason: "modified" },
      { destination: unrecorded, reason: "unrecorded" },
    ]);
    expect(await preflightGlobalPlan(generation, { state, onModified: "backup", accept: new Set([instruction, unrecorded]) })).toEqual([]);
  });

  test("backs up a whole skill directory and restores it", async () => {
    const root = await directory("agentsmith-skill-backup-");
    const skill = join(root, "skills", "review");
    const skillFile = join(skill, "SKILL.md");
    const reference = join(skill, "references", "guide.md");
    await mkdir(join(skill, "references"), { recursive: true });
    await writeFile(skillFile, "generated\n");
    await writeFile(reference, "edited\n");
    const state = {
      version: 1 as const,
      artifacts: { [skillFile]: hashBytes(bytes("generated\n")), [reference]: hashBytes(bytes("generated\n")) },
    };
    const generation = plan([write(skillFile, "next\n", "skill"), write(reference, "next\n", "skill")]);
    const conflicts = await preflightGlobalPlan(generation, { state, onModified: "backup" });
    expect(conflicts).toEqual([{ destination: reference, reason: "modified" }]);
    const date = new Date("2026-11-10T12:34:56.789Z");
    const backupRoot = join(root, "backups");
    const backups = await backupGlobalArtifacts(conflicts, { plan: generation, state, date, backupRoot });
    const expected = join(backupRoot, "20261110T123456Z", skill.slice(1));
    expect(backups).toEqual([{ path: skill, backup: expected, reason: "modified" }]);
    expect(await readFile(join(expected, "references", "guide.md"), "utf8")).toBe("edited\n");
    // Nothing is left in the skill root that a harness could load as a second copy.
    expect(await readdir(join(root, "skills"))).toEqual([]);
    await restoreBackups(backups);
    expect(await readFile(reference, "utf8")).toBe("edited\n");
  });

  test("never overwrites an existing backup", async () => {
    const root = await directory("agentsmith-backup-name-");
    const file = join(root, "CLAUDE.md");
    const date = new Date("2026-11-10T00:00:00Z");
    await writeFile(`${file}.agentsmith-${backupTimestamp(date)}`, "older backup\n");
    await writeFile(file, "edited\n");
    const backups = await backupGlobalArtifacts([{ destination: file, reason: "modified" }], {
      plan: plan([]),
      state: { version: 1, artifacts: {} },
      date,
    });
    expect(backups[0]?.backup).toBe(`${file}.agentsmith-20261110T000000Z-1`);
  });
});

describe("exit codes and durations", () => {
  test("classify untyped failures without hiding typed ones", async () => {
    await expect(classify("config", () => Promise.reject(new Error("bad")))).rejects.toMatchObject({ code: "config" });
    await expect(classify("config", () => Promise.reject(new AgentsmithError("source-pull", "pull")))).rejects.toMatchObject({ code: "source-pull" });
    expect(exitCodeFor(new Error("other"))).toBe(EXIT_CODES.failure);
    expect(new Set(Object.values(EXIT_CODES)).size).toBe(Object.keys(EXIT_CODES).length);
  });

  test("parse max-age durations", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(() => parseDuration("10")).toThrow("Invalid duration");
    expect(() => parseDuration("0s")).toThrow("positive");
  });
});
