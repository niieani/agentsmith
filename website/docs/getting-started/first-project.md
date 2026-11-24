---
title: Your first project
description: Generate AGENTS.md and CLAUDE.md for a Git repository.
---

Project generation combines reusable sources with configuration committed to a project. It never synchronizes or pulls Git.

## 1. Initialize the project

At the repository root, run:

```sh
asmith project init
```

This writes `.config/agentsmith/config.toml`, adds the generated skill folders and `*.local.md` snippets to `.gitignore`, and keeps a `.gitkeep` in each skill folder. Add `--prepare` to regenerate on every package install; see [committing project instructions](/guides/committing-project-instructions).

Then give the repository scope a template that lives in the project, so the committed files carry it:

```toml title=".config/agentsmith/config.toml"
harnesses = ["generic", "codex", "claude"]

[[scopes]]
path = "."
template = "project"
packs = ["team", "base", "github"]
```

```md title=".config/agentsmith/templates/project/default.md"
# Working in this repository

<!-- agentsmith:slot conventions -->
```

Every project must declare the repository scope with `path = "."`. Templates and packs under `.config/agentsmith/` are shared: they render into the committed `AGENTS.md` and `CLAUDE.md`. Names that come from your Source Repository, such as `base` and `github` here, are personal: they render into `AGENTS.override.md` and `CLAUDE.local.md`, which Git never sees.

With `antigravity` selected, Antigravity reads the same `AGENTS.md`. It loads every instruction file it finds and cannot read a personal file instead, so agentsmith adds to it with always-on rules only Antigravity reads: `instructions/antigravity/` snippets from the project go to the committed `.agents/rules/agentsmith.md`, and personal additions to `.agents/rules/agentsmith-personal.md`, which Git never sees.

## 2. Preview the plan

```sh
asmith project lint
asmith project explain
asmith project diff
```

- `lint` validates configuration, composition, collisions, and budgets.
- `explain` shows why each artifact exists and where its content came from.
- `diff` renders without writing and shows prospective changes.

## 3. Generate

```sh
asmith project generate
git add AGENTS.md CLAUDE.md .config/agentsmith .gitignore .agents .claude
git commit -m "chore: generate agent context"
```

If `CLAUDE.md` would repeat `AGENTS.md` exactly, agentsmith writes it as a one-line `@AGENTS.md` import so Claude Code reads the shared file once. Set `claude_import_agents_md = false` to write the full content instead. Skills go to `.agents/skills`, which Codex also reads, and `.claude/skills`; they are generated, not committed.

agentsmith only overwrites project outputs that Git reports as tracked and clean, or that still hold exactly what agentsmith last wrote. A generated file you edited by hand stops the run until you restore or commit it.

:::warning
Project-only sources work without machine configuration. Without one, names only the Source Repository could provide, and `source:` references, are skipped with a notice, so a fresh clone still generates the shared files and shared skills. When a machine config exists, project planning loads it so matching Source Repository packs cannot be omitted silently; that config must therefore be valid.
:::
