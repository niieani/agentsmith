import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXCLUDE_BLOCK_END,
  EXCLUDE_BLOCK_START,
  excludeEntry,
  readClaudeSettings,
  readInfoExclude,
  updateClaudeMdExcludes,
  updateInfoExclude,
} from "../src/personal.ts";

describe("info/exclude entries", () => {
  test("adds missing lines to its own block, never twice, and never removes any line", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-exclude-"));
    const path = join(root, "info", "exclude");
    const block = (...lines: string[]) => [EXCLUDE_BLOCK_START, ...lines, EXCLUDE_BLOCK_END].join("\n");
    expect(await updateInfoExclude(path, ["/AGENTS.override.md", "/AGENTS.override.md"])).toEqual(["/AGENTS.override.md"]);
    expect(await readFile(path, "utf8")).toBe(`${block("/AGENTS.override.md")}\n`);
    // A line already present anywhere in the file is not added again; new lines go inside the existing block.
    const header = "# git ls-files --others --exclude-from=.git/info/exclude\n*.swp\n/CLAUDE.local.md\n";
    await writeFile(path, `${header}${block("/AGENTS.override.md")}\n# mine\n*.log\n`);
    expect(await updateInfoExclude(path, ["/AGENTS.override.md", "/CLAUDE.local.md", "/app/AGENTS.override.md"])).toEqual(["/app/AGENTS.override.md"]);
    expect(await readFile(path, "utf8")).toBe(`${header}${block("/AGENTS.override.md", "/app/AGENTS.override.md")}\n# mine\n*.log\n`);
    // Nothing to add leaves the file untouched; dropping an entry from the desired list removes nothing.
    expect(await updateInfoExclude(path, ["/app/AGENTS.override.md"])).toEqual([]);
    expect(await readFile(path, "utf8")).toContain("/AGENTS.override.md\n/app/AGENTS.override.md\n");
    expect(await readInfoExclude(path)).toEqual(["*.swp", "/CLAUDE.local.md", "/AGENTS.override.md", "/app/AGENTS.override.md", "*.log"]);
  });

  test("anchors entries at the worktree root", () => {
    expect(excludeEntry("/repo", "/repo/app/AGENTS.override.md")).toBe("/app/AGENTS.override.md");
    expect(excludeEntry("/repo", "/repo/.claude/skills/review", true)).toBe("/.claude/skills/review/");
  });
});

describe("claudeMdExcludes", () => {
  test("merges entries into existing settings and removes only its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-settings-"));
    const path = join(root, ".claude", "settings.local.json");
    await updateClaudeMdExcludes(path, [], ["/x/CLAUDE.md"]);
    expect(existsSync(path)).toBeFalse();
    await updateClaudeMdExcludes(path, ["/x/CLAUDE.md"], []);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ claudeMdExcludes: ["/x/CLAUDE.md"] });
    await writeFile(path, JSON.stringify({ model: "opus", claudeMdExcludes: ["/theirs/CLAUDE.md", "/x/CLAUDE.md"] }));
    await updateClaudeMdExcludes(path, ["/y/CLAUDE.md"], ["/x/CLAUDE.md"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ model: "opus", claudeMdExcludes: ["/theirs/CLAUDE.md", "/y/CLAUDE.md"] });
    await writeFile(path, JSON.stringify({ model: "opus", claudeMdExcludes: ["/y/CLAUDE.md"] }));
    await updateClaudeMdExcludes(path, [], ["/y/CLAUDE.md"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ model: "opus" });
    // A file left with nothing in it is removed.
    await writeFile(path, JSON.stringify({ claudeMdExcludes: ["/y/CLAUDE.md"] }));
    await updateClaudeMdExcludes(path, [], ["/y/CLAUDE.md"]);
    expect(existsSync(path)).toBeFalse();
  });

  test("rejects settings that are not a JSON object with a string list", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-settings-"));
    const path = join(root, "settings.local.json");
    expect(await readClaudeSettings(path)).toBeUndefined();
    for (const content of ["[]", "{", '{"claudeMdExcludes": "CLAUDE.md"}']) {
      await writeFile(path, content);
      await expect(readClaudeSettings(path)).rejects.toThrow(path);
    }
  });
});
