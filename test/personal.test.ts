import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excludeEntry, readClaudeSettings, updateClaudeMdExcludes, updateInfoExclude } from "../src/personal.ts";

describe("info/exclude entries", () => {
  test("adds missing lines and removes only owned ones, keeping everything else", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-exclude-"));
    const path = join(root, "info", "exclude");
    await updateInfoExclude(path, ["/AGENTS.override.md"], []);
    expect(await readFile(path, "utf8")).toBe("/AGENTS.override.md\n");
    await writeFile(path, "# git ls-files --others --exclude-from=.git/info/exclude\n*.swp\n/AGENTS.override.md\n");
    await updateInfoExclude(path, ["/AGENTS.override.md", "/CLAUDE.local.md"], []);
    expect(await readFile(path, "utf8")).toBe("# git ls-files --others --exclude-from=.git/info/exclude\n*.swp\n/AGENTS.override.md\n/CLAUDE.local.md\n");
    await updateInfoExclude(path, ["/CLAUDE.local.md"], ["/AGENTS.override.md", "/CLAUDE.local.md", "*.swp-not-owned"]);
    expect(await readFile(path, "utf8")).toBe("# git ls-files --others --exclude-from=.git/info/exclude\n*.swp\n/CLAUDE.local.md\n");
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
