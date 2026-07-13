import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GenerationPlan, PlannedWrite } from "../src/types.ts";
import { runCommand, gitWorktree } from "../src/git.ts";
import {
  applyPlan,
  globalStatePath,
  hashBytes,
  loadGlobalState,
  loadProjectState,
  preflightGlobalPlan,
  preflightProjectPlan,
  projectStatePath,
  saveGlobalState,
  saveProjectState,
  unifiedDiff,
} from "../src/safety.ts";

const temporary: string[] = [];
const bytes = (value: string) => new TextEncoder().encode(value);
const write = (destination: string, content: string): PlannedWrite => ({
  destination,
  content: bytes(content),
  kind: "instruction",
  provenance: ["test"],
});
const plan = (writes: PlannedWrite[], deletes: GenerationPlan["deletes"] = []): GenerationPlan => ({ writes, deletes, diagnostics: [], explanation: {} });

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-safe-"));
  temporary.push(root);
  await runCommand("git", ["init", "-q"], { cwd: root });
  await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: root });
  await Bun.write(join(root, "AGENTS.md"), "old\n");
  await runCommand("git", ["add", "."], { cwd: root });
  await runCommand("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("state", () => {
  test("round trips project state under the actual git directory", async () => {
    const root = await repository();
    const path = projectStatePath(await gitWorktree(root));
    expect(path).toBe(join(root, ".git", "agentsmith", "state.toml"));
    await saveProjectState(path, { version: 1, paths: ["z", "a", "a"] });
    expect(await loadProjectState(path)).toEqual({ version: 1, paths: ["a", "z"] });
  });

  test("round trips global ownership hashes at the namespaced path", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentsmith-home-"));
    temporary.push(home);
    const path = globalStatePath(home);
    const artifact = join(home, "AGENTS.md");
    await saveGlobalState(path, { version: 1, artifacts: { [artifact]: hashBytes(bytes("x")) } });
    expect(await loadGlobalState(path)).toEqual({ version: 1, artifacts: { [artifact]: hashBytes(bytes("x")) } });
  });
});

describe("preflight", () => {
  test("project writes allow tracked-clean or missing and reject dirty files", async () => {
    const root = await repository();
    await expect(preflightProjectPlan(plan([write(join(root, "AGENTS.md"), "new\n")]), { projectRoot: root, state: { version: 1, paths: [] } })).resolves.toBeUndefined();
    await expect(preflightProjectPlan(plan([write(join(root, "new.md"), "new\n")]), { projectRoot: root, state: { version: 1, paths: [] } })).resolves.toBeUndefined();
    await Bun.write(join(root, "AGENTS.md"), "dirty\n");
    await expect(preflightProjectPlan(plan([write(join(root, "AGENTS.md"), "new\n")]), { projectRoot: root, state: { version: 1, paths: [] } })).rejects.toThrow("modified");
  });

  test("project stale deletion must be recorded and Git-clean", async () => {
    const root = await repository();
    const deletion = { destination: join(root, "AGENTS.md"), kind: "instruction" as const };
    await expect(preflightProjectPlan(plan([], [deletion]), { projectRoot: root, state: { version: 1, paths: [] } })).rejects.toThrow("unrecorded");
    await expect(preflightProjectPlan(plan([], [deletion]), { projectRoot: root, state: { version: 1, paths: ["AGENTS.md"] } })).resolves.toBeUndefined();
  });

  test("global writes require adoption then preserve hash ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-global-"));
    temporary.push(root);
    const destination = join(root, "AGENTS.md");
    await Bun.write(destination, "old\n");
    const generation = plan([write(destination, "new\n")]);
    await expect(preflightGlobalPlan(generation, { state: { version: 1, artifacts: {} } })).rejects.toThrow("unrecorded");
    await expect(preflightGlobalPlan(generation, { state: { version: 1, artifacts: {} }, force: true })).resolves.toBeUndefined();
    const state = { version: 1 as const, artifacts: { [destination]: hashBytes(bytes("old\n")) } };
    await expect(preflightGlobalPlan(generation, { state })).resolves.toBeUndefined();
    await Bun.write(destination, "edited\n");
    await expect(preflightGlobalPlan(generation, { state })).rejects.toThrow("modified");
  });
});

describe("application", () => {
  test("applies writes and deletions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-apply-"));
    temporary.push(root);
    const replaced = join(root, "old.md");
    const deleted = join(root, "gone.md");
    await Bun.write(replaced, "old");
    await Bun.write(deleted, "gone");
    await applyPlan(plan([write(replaced, "new")], [{ destination: deleted, kind: "instruction" }]));
    expect(await Bun.file(replaced).text()).toBe("new");
    expect(await Bun.file(deleted).exists()).toBe(false);
  });

  test("rolls every prior operation back after an application failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-rollback-"));
    temporary.push(root);
    const first = join(root, "first.md");
    const second = join(root, "second.md");
    await Bun.write(first, "first-old");
    await Bun.write(second, "second-old");
    await expect(applyPlan(plan([write(first, "first-new"), write(second, "second-new")]), {
      beforeOperation: (_operation, index) => { if (index === 1) throw new Error("injected failure"); },
    })).rejects.toThrow("injected failure");
    expect(await readFile(first, "utf8")).toBe("first-old");
    expect(await readFile(second, "utf8")).toBe("second-old");
  });

  test("supports owned file and directory layout transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-transition-"));
    temporary.push(root);
    const parent = join(root, "references");
    const child = join(parent, "guide.md");
    await Bun.write(parent, "old-file");
    await applyPlan(plan([write(child, "nested")], [{ destination: parent, kind: "skill" }]));
    expect(await readFile(child, "utf8")).toBe("nested");
    await applyPlan(plan([write(parent, "flat")], [{ destination: child, kind: "skill" }]));
    expect(await readFile(parent, "utf8")).toBe("flat");
  });
});

test("unifiedDiff emits headers and changed lines", () => {
  expect(unifiedDiff("one\ntwo\n", "one\nthree\n", "AGENTS.md")).toContain("--- a/AGENTS.md\n+++ b/AGENTS.md");
  expect(unifiedDiff("one\ntwo\n", "one\nthree\n")).toContain("-two\n+three");
  expect(unifiedDiff("same", "same")).toBe("");
});
