---
title: Committing project instructions
description: Commit the shared instructions your team agrees on, keep your own on top, and generate skills on install.
---

A repository's agent context has two audiences. The team agrees on shared instructions and reviews them like code. Each developer also has personal instructions and skills from their own Source Repository that should never show up in a diff. agentsmith keeps the two apart by where each input lives, not by which file it ends up in.

| | Shared | Personal |
| --- | --- | --- |
| Inputs | everything in `.config/agentsmith/` except `*.local.md` | your Source Repository, and `*.local.md` files |
| Instruction files | `AGENTS.md`, `CLAUDE.md` | `AGENTS.override.md`, `CLAUDE.local.md` |
| In Git | committed | excluded through `.git/info/exclude` |
| Skills | generated into `.agents/skills`, `.codex/skills`, `.claude/skills`, never committed | the same folders |

## Set up the repository

```sh
asmith project init --prepare
```

`project init`:

1. Writes `.config/agentsmith/config.toml` for the harnesses whose folders already exist (`.agents/` for `generic`, `.codex/` for `codex`, `.claude/` for `claude`), or all three.
2. Adds the generated skill folders and personal snippets to `.gitignore`, keeping a `.gitkeep` placeholder in each skill folder:

   ```text title=".gitignore"
   # agentsmith: generated skills and personal snippets
   /.agents/skills/*
   !/.agents/skills/.gitkeep
   /.codex/skills/*
   !/.codex/skills/.gitkeep
   /.claude/skills/*
   !/.claude/skills/.gitkeep
   /.config/agentsmith/**/*.local.md
   ```

   Claude Code only watches skill folders that existed when the session started. The committed placeholder keeps the folder there, so skills generated during a session appear on the next turn. Codex picks up new skills on the next turn either way.
3. With `--prepare`, adds `asmith` as a dev dependency and sets `scripts.prepare` to `asmith project generate`, so every install regenerates skills and personal files with the version the repository pins. The package manager comes from the `packageManager` field of `package.json`, then the lockfile (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`), then npm. An existing `prepare` script that does something else is kept as is; init prints the chained command to add yourself, such as `"prepare": "husky && asmith project generate"`.

Rerunning `project init` changes nothing that is already in place. Nested scopes need the same `.gitignore` lines for their own skill folders, for example `/apps/web/.claude/skills/*`.

## Write the shared layer

Put what the team shares in `.config/agentsmith/`: a template family, project packs, partials, and skills.

A template from your Source Repository is personal, so the committed `AGENTS.md` cannot use it. To start from one you already have, copy it into the project:

```sh
asmith project init --template project
```

This copies every variant of `templates/project/` and the partials it includes into `.config/agentsmith/`, and sets `template = "project:project"`. It never overwrites a project file. Once copied, the template is the team's: edit and review it with the rest of the repository.

```text
.config/agentsmith/
├── config.toml
├── templates/project/default.md
└── packs/team/
    ├── pack.toml
    └── instructions/verification/10-tests.md
```

```toml title=".config/agentsmith/config.toml"
harnesses = ["generic", "codex", "claude"]

[[scopes]]
path = "."
template = "project"
packs = ["team", "base"]   # "base" comes from your Source Repository: personal
```

```sh
asmith project generate
git add .config/agentsmith .gitignore .agents .claude AGENTS.md CLAUDE.md
git commit -m "chore: add agent instructions"
```

`AGENTS.md` and `CLAUDE.md` hold only the shared inputs. A pack, template, or partial that comes from your Source Repository, and any `*.local.md` snippet, never changes them, so you can keep your own instructions without touching what the team reviews.

## Your personal layer

When your personal inputs add something, `project generate` also writes:

- `AGENTS.override.md`: the shared layer plus your inputs. Codex reads it instead of `AGENTS.md`.
- `CLAUDE.local.md`: the same for Claude Code, plus an entry for `CLAUDE.md` in `claudeMdExcludes` in `.claude/settings.local.json`, so Claude reads only `CLAUDE.local.md`. agentsmith adds and removes only its own entries and keeps your other settings.

Both files, and `.claude/settings.local.json` when Git does not already ignore it, are listed in `.git/info/exclude`, so the repository never mentions them. agentsmith keeps its lines there in one marked block:

```text
# BEGIN agentsmith: personal files, shared by every worktree. agentsmith adds lines here and never removes them.
/AGENTS.override.md
/CLAUDE.local.md
/.claude/settings.local.json
# END agentsmith
```

When your personal inputs stop changing anything, the files and the settings entry go away on the next generation. The exclude lines stay, even after `project clean`: every worktree of a repository shares `.git/info/exclude`, so removing a line could make another worktree's personal file show up in `git status`. A line for a file that does not exist does nothing; delete the block by hand if you no longer want it. Generic tools read only `AGENTS.md`.

To add a personal note to one repository, write a `*.local.md` snippet in a project pack; `.gitignore` keeps it out of Git:

```sh
echo "I run the slow suite with make test-all." > .config/agentsmith/packs/team/instructions/verification/90-mine.local.md
asmith project generate
```

## Teammates and CI

A clone without a machine config still generates: `project generate` renders the shared layer and shared skills, and prints a `NOTICE personal-input-skipped` line for each personal input it leaves out. With `--prepare`, `npm install` (or `pnpm install`, `bun install`, `yarn`) runs it automatically.

agentsmith generates skills from the configuration, so the committed `AGENTS.md` and `CLAUDE.md` are the only instructions a fresh clone has before its first install. Two optional additions help an agent that starts before anyone ran the install.

### Optional: tell agents to install

Add a snippet to the shared layer, for example `.config/agentsmith/packs/team/instructions/setup/10-install.md` with a `setup` slot in your template:

```md title=".config/agentsmith/packs/team/instructions/setup/10-install.md"
If `.agents/skills/` holds nothing but `.gitkeep`, run `pnpm install` before you start. The project's skills appear from your next turn.
```

Use the install command of your package manager. Skills generated during a turn are not loaded in that same turn.

### Optional: a session hook

agentsmith installs no hooks. A SessionStart hook runs on every start, resume, compaction, and subagent, and neither Codex nor Claude Code loads instruction files or skills that a hook creates during the same turn. If you still want one, a Claude Code hook in the committed `.claude/settings.json` can install only when the skills are missing:

```json title=".claude/settings.json"
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "[ -n \"$(ls -A .claude/skills | grep -v '^.gitkeep$')\" ] || pnpm install >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

The skills it generates appear from the next turn.

## Repositories you do not own

For an open-source checkout or a vendor repository whose `AGENTS.md` and `CLAUDE.md` you must not change, use `upstream = "keep"` or `"replace"`, or a `[[projects]]` entry in your profile. agentsmith then writes only personal files and never a committed one. See [third-party repositories](/reference/configuration#third-party-repositories).
