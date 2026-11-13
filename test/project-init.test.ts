import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { addDevDependency, detectHarnesses, detectPackageManager, ignoreEntries, runAsmith } from "../src/project-init.ts";
import { cli, commitAll, projectFixture, put, run, skillMd, type ProjectFixture } from "./support/project.ts";

/** Fake package managers on PATH: each logs its arguments and adds asmith to devDependencies like the real one. */
async function fakePackageManagers(f: ProjectFixture): Promise<{ env: Record<string, string | undefined>; log: string }> {
  const bin = join(f.root, "fake-bin");
  const log = join(f.root, "pm.log");
  await mkdir(bin, { recursive: true });
  const script = [
    "#!/bin/sh",
    `echo "$(basename "$0") $*" >> ${JSON.stringify(log)}`,
    `${JSON.stringify(process.execPath)} -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.devDependencies={...p.devDependencies,asmith:"^0.3.0"};fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\\n")'`,
    "",
  ].join("\n");
  for (const name of ["bun", "npm", "pnpm", "yarn"]) {
    await put(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  return { env: { ...f.env, PATH: `${bin}:${f.env.PATH ?? ""}` }, log };
}

describe("project init", () => {
  test("writes a config for the harnesses present, ignore entries, and skill folder placeholders, idempotently", async () => {
    const f = await projectFixture("agentsmith-init-");
    await put(join(f.project, ".claude", "skills", "authors-skill", "SKILL.md"), skillMd("authors-skill"));
    await put(join(f.project, ".gitignore"), "node_modules\n");
    await commitAll(f, "existing");
    const first = await f.asmith("project", "init");
    expect(first.exitCode, first.stderr).toBe(0);
    const config = await readFile(join(f.config, "config.toml"), "utf8");
    expect(config).toContain('harnesses = ["claude"]');
    expect(await readFile(join(f.project, ".gitignore"), "utf8")).toBe(
      "node_modules\n\n# agentsmith: generated skills and personal snippets\n/.claude/skills/*\n!/.claude/skills/.gitkeep\n/.config/agentsmith/**/*.local.md\n",
    );
    expect(existsSync(join(f.project, ".claude", "skills", ".gitkeep"))).toBeTrue();
    expect(first.stderr).toContain("WARNING committed-skill: .claude/skills/authors-skill is committed");
    // The config generates as written, and the placeholder is the only new file Git sees in the skill root.
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect((await f.git("status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean).sort()).toEqual([
      " M .gitignore",
      "?? .claude/skills/.gitkeep",
      "?? .config/agentsmith/config.toml",
    ]);
    await put(join(f.project, ".claude", "skills", "generated", "SKILL.md"), skillMd("generated"));
    expect(await f.git("status", "--porcelain", "--", ".claude/skills/generated")).toBe("");

    const before = { config, gitignore: await readFile(join(f.project, ".gitignore"), "utf8") };
    const second = await f.asmith("project", "init");
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.stdout).toContain("already exists; left unchanged");
    expect(await readFile(join(f.config, "config.toml"), "utf8")).toBe(before.config);
    expect(await readFile(join(f.project, ".gitignore"), "utf8")).toBe(before.gitignore);
  });

  test("--prepare adds asmith with the detected package manager and a prepare script, and is idempotent", async () => {
    const f = await projectFixture("agentsmith-init-prepare-");
    await put(join(f.project, "package.json"), `${JSON.stringify({ name: "app", packageManager: "pnpm@9.1.0", scripts: { test: "vitest" } }, null, 4)}\n`);
    await put(join(f.project, "yarn.lock"), "");
    await commitAll(f, "app");
    const pm = await fakePackageManagers(f);
    const init = () => run([process.execPath, cli, "project", "init", "--prepare"], f.project, pm.env);
    const first = await init();
    expect(first.exitCode, first.stderr).toBe(0);
    expect(await readFile(pm.log, "utf8")).toBe("pnpm add -D asmith\n");
    const manifest = await readFile(join(f.project, "package.json"), "utf8");
    expect(JSON.parse(manifest).scripts).toEqual({ test: "vitest", prepare: "asmith project generate" });
    expect(first.stdout).toContain("run pnpm exec asmith project generate");
    expect(existsSync(join(f.config, "config.toml"))).toBeTrue();

    const second = await init();
    expect(second.exitCode, second.stderr).toBe(0);
    expect(await readFile(pm.log, "utf8")).toBe("pnpm add -D asmith\n");
    expect(await readFile(join(f.project, "package.json"), "utf8")).toBe(manifest);
    expect(second.stdout).toContain("scripts.prepare already runs asmith project generate");
  });

  test("--prepare keeps a foreign prepare script and prints the chained command", async () => {
    const f = await projectFixture("agentsmith-init-foreign-");
    await put(join(f.project, "package.json"), `${JSON.stringify({ name: "app", scripts: { prepare: "husky" } }, null, 2)}\n`);
    await put(join(f.project, "bun.lock"), "");
    await commitAll(f, "app");
    const pm = await fakePackageManagers(f);
    const result = await run([process.execPath, cli, "project", "init", "--prepare"], f.project, pm.env);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(pm.log, "utf8")).toBe("bun add -d asmith\n");
    expect(JSON.parse(await readFile(join(f.project, "package.json"), "utf8")).scripts).toEqual({ prepare: "husky" });
    expect(result.stderr).toContain("WARNING prepare-script-kept");
    expect(result.stderr).toContain('"prepare": "husky && asmith project generate"');
    expect(result.stdout).toContain("run bunx asmith project generate");
  });

  test("--prepare needs a package.json, and init needs a Git repository", async () => {
    const f = await projectFixture("agentsmith-init-errors-");
    const prepare = await f.asmith("project", "init", "--prepare");
    expect(prepare.exitCode).toBe(2);
    expect(prepare.stderr).toContain("--prepare needs a package.json");
    const outside = await run(["bun", cli, "project", "init"], f.root, f.env);
    expect(outside.exitCode).toBe(2);
    expect(outside.stderr).toContain("project init needs a Git repository");
  });
});

describe("project init helpers", () => {
  test("detects the package manager from packageManager, then lockfiles, then npm", async () => {
    const f = await projectFixture("agentsmith-pm-");
    expect(detectPackageManager(f.project, {})).toBe("npm");
    expect(detectPackageManager(f.project, { packageManager: "yarn@4.1.0" })).toBe("yarn");
    for (const [file, manager] of [
      ["package-lock.json", "npm"],
      ["yarn.lock", "yarn"],
      ["pnpm-lock.yaml", "pnpm"],
      ["bun.lockb", "bun"],
    ] as const) {
      await put(join(f.project, file), "");
      expect(detectPackageManager(f.project, { packageManager: "unknown@1" })).toBe(manager);
    }
    expect(detectPackageManager(f.project, { packageManager: "npm@10.0.0" })).toBe("npm");
  });

  test("names each package manager's commands", () => {
    expect(addDevDependency("npm")).toEqual(["npm", "install", "-D", "asmith"]);
    expect(addDevDependency("bun")).toEqual(["bun", "add", "-d", "asmith"]);
    expect([runAsmith("bun", true), runAsmith("pnpm", true), runAsmith("yarn", true), runAsmith("npm", true)]).toEqual([
      "bunx asmith",
      "pnpm exec asmith",
      "yarn asmith",
      "npx asmith",
    ]);
    expect(runAsmith("pnpm", false)).toBe("pnpm dlx asmith");
  });

  test("ignores each selected harness's skill root and personal snippets", async () => {
    expect(ignoreEntries(["generic", "codex", "claude"])).toEqual([
      "/.agents/skills/*",
      "!/.agents/skills/.gitkeep",
      "/.codex/skills/*",
      "!/.codex/skills/.gitkeep",
      "/.claude/skills/*",
      "!/.claude/skills/.gitkeep",
      "/.config/agentsmith/**/*.local.md",
    ]);
    const f = await projectFixture("agentsmith-detect-");
    expect(detectHarnesses(f.project)).toEqual(["generic", "codex", "claude"]);
    await mkdir(join(f.project, ".codex"));
    await mkdir(join(f.project, ".agents"));
    expect(detectHarnesses(f.project)).toEqual(["generic", "codex"]);
  });
});
