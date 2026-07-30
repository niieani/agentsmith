---
title: Configuration reference
description: Strict TOML schemas for machines, profiles, packs, and projects.
---

Every agentsmith TOML document requires `version = 1`. Unknown keys, wrong types, duplicate selected packs, unknown harnesses, and missing sources are errors.

## Machine config

Default path: `~/.agents/agentsmith/config.toml`.

```toml
version = 1
source = "~/.agents/agentsmith/source"
profile = "laptop"
```

| Key | Required | Meaning |
| --- | --- | --- |
| `version` | Yes | Schema version; currently `1`. |
| `source` | Yes | Source Repository path. |
| `profile` | Yes | Profile filename without `.toml`. |

## Root config

Path: `<source>/agentsmith.toml`.

```toml
version = 1

[budgets]
instruction_layer_bytes = 24576
effective_instruction_bytes = 32768
skill_markdown_bytes = 16384
```

All budget values are optional positive UTF-8 byte thresholds. They warn rather than truncate.

## Profile

Path: `<source>/profiles/<name>.toml`.

```toml
version = 1
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

Path: `<source>/packs/<name>/pack.toml` or `.config/agentsmith/packs/<name>/pack.toml`.

```toml
version = 1
skills = ["to-issues", "address-review"]
```

`skills` is ordered and optional.

## Project config

Path: `<project>/.config/agentsmith/config.toml`.

```toml
version = 1
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

Top-level project keys are `version`, `harnesses`, `budgets`, and `scopes`. Scope keys are `path`, `template`, `packs`, `harnesses`, `skills_enable`, and `skills_disable`.

## Harness destinations

| Harness | Global instructions | Project instructions | Global skills | Project skills |
| --- | --- | --- | --- | --- |
| Codex | `$CODEX_HOME/AGENTS.md` (normally `~/.codex/AGENTS.md`) | `<scope>/AGENTS.md` | `~/.agents/skills` | `<scope>/.agents/skills` |
| Claude Code | `~/.claude/CLAUDE.md` | `<scope>/CLAUDE.md` | `~/.claude/skills` | `<scope>/.claude/skills` |

An existing `AGENTS.override.md` at a generated Codex layer is a preflight error because it would shadow `AGENTS.md`.
