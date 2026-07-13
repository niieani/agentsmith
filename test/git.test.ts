import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCleanSource, gitPathStatus, gitWorktree, runCommand } from "../src/git.ts";

const temporary: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-git-"));
  temporary.push(root);
  await runCommand("git", ["init", "-q"], { cwd: root });
  await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: root });
  await Bun.write(join(root, ".gitignore"), "*.local.md\nignored.md\n");
  await Bun.write(join(root, "tracked.md"), "old\n");
  await runCommand("git", ["add", "."], { cwd: root });
  await runCommand("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Git boundary", () => {
  test("finds the real worktree and git directory", async () => {
    const root = await repository();
    await mkdir(join(root, "a", "b"), { recursive: true });
    expect(await gitWorktree(join(root, "a", "b"))).toEqual({ root, gitDir: join(root, ".git") });
  });

  test("classifies clean, dirty, staged, untracked, ignored, and missing paths", async () => {
    const root = await repository();
    expect(await gitPathStatus(root, join(root, "tracked.md"))).toBe("tracked-clean");
    await Bun.write(join(root, "tracked.md"), "changed\n");
    expect(await gitPathStatus(root, join(root, "tracked.md"))).toBe("modified");
    await runCommand("git", ["add", "tracked.md"], { cwd: root });
    expect(await gitPathStatus(root, join(root, "tracked.md"))).toBe("staged");
    await Bun.write(join(root, "new.md"), "new\n");
    expect(await gitPathStatus(root, join(root, "new.md"))).toBe("untracked");
    await Bun.write(join(root, "ignored.md"), "local\n");
    expect(await gitPathStatus(root, join(root, "ignored.md"))).toBe("ignored");
    expect(await gitPathStatus(root, join(root, "missing.md"))).toBe("missing");
  });

  test("clean-source validation permits ignored local files only", async () => {
    const root = await repository();
    await Bun.write(join(root, "notes.local.md"), "machine only\n");
    await expect(ensureCleanSource(root)).resolves.toBeUndefined();
    await Bun.write(join(root, "new.md"), "not ignored\n");
    await expect(ensureCleanSource(root)).rejects.toThrow("nonignored untracked");
  });
});
