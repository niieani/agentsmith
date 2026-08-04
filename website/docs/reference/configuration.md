---
title: Configuration reference
description: Strict TOML schemas for machines, profiles, packs, and projects.
---

Every agentsmith TOML document is strict. Configuration files have no schema-version field: `version` and all other unknown keys are errors. Wrong types, duplicate selected packs, unknown harnesses, and missing sources are also errors.

## Machine config

Default path: `~/.agents/agentsmith/config.toml`.

```toml
source = "~/.agents/agentsmith/source"
profile = "laptop"
```

| Key | Required | Meaning |
| --- | --- | --- |
| `source` | Yes | Source Repository path. |
| `profile` | Yes | Profile filename without `.toml`. |

## Root config

Path: `<source>/agentsmith.toml`.

```toml
[budgets]
instruction_layer_bytes = 24576
effective_instruction_bytes = 32768
skill_markdown_bytes = 16384
```

All budget values are optional positive UTF-8 byte thresholds. They warn rather than truncate.

## Profile

Path: `<source>/profiles/<name>.toml`.

```toml
harnesses = ["codex", "claude-code"]
template = "personal"
packs = ["base", "personal", "macos"]
skills_enable = ["review-worktree"]
skills_disable = ["publish"]

[budgets]
effective_instruction_bytes = 28672
```

Profile budgets override matching Source Repository defaults.

## Pack

Path, when needed: `<source>/packs/<name>/pack.toml` or `.config/agentsmith/packs/<name>/pack.toml`.

```toml
skills = ["to-issues", "address-review"]
```

A pack directory needs no manifest when it only contributes instructions or skill slots. Add `pack.toml` only to enable skills. When present, it accepts only the optional, ordered `skills` field; omitting `skills` is equivalent to an empty list.

## Project config

Path: `<project>/.config/agentsmith/config.toml`.

```toml
harnesses = ["codex", "claude-code"]

[budgets]
instruction_layer_bytes = 20000
effective_instruction_bytes = 32000
skill_markdown_bytes = 16000

[[scopes]]
path = "."
template = "software"
packs = ["base", "bun", "github"]
skills_enable = []
skills_disable = ["publish"]

[[scopes]]
path = "apps/ios"
template = "ios"
packs = ["swift", "ios"]
harnesses = ["codex"]
skills_enable = ["simulator-debug"]
skills_disable = []
```

Top-level project keys are `harnesses`, `budgets`, and `scopes`. Scope keys are `path`, `template`, `packs`, `harnesses`, `skills_enable`, and `skills_disable`.

## Source IDs

Source IDs are slash-separated logical names, not filesystem paths. Unqualified names are preferred. In project mode, templates, skills, and partials resolve project-first with Source Repository fallback; packs compose Source Repository and project matches in that order. `source:` and `project:` restrict resolution to one owner. Global profiles resolve only Source Repository sources and reject `project:` references. A name missing from every eligible owner is an error.

## Harness destinations

| Harness | Global instructions | Project instructions | Global skills | Project skills |
| --- | --- | --- | --- | --- |
| Codex | `$CODEX_HOME/AGENTS.md` (normally `~/.codex/AGENTS.md`) | `<scope>/AGENTS.md` | `~/.agents/skills` | `<scope>/.agents/skills` |
| Claude Code | `~/.claude/CLAUDE.md` | `<scope>/CLAUDE.md` | `~/.claude/skills` | `<scope>/.claude/skills` |

An existing `AGENTS.override.md` at a generated Codex layer is a preflight error because it would shadow `AGENTS.md`.
