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
harnesses = ["codex", "claude"]
template = "personal"
packs = ["base", "personal", "macos"]
skills_enable = ["review-worktree"]
skills_disable = ["publish"]

[budgets]
effective_instruction_bytes = 28672
```

Profile budgets override matching Source Repository defaults.

| Key | Required | Meaning |
| --- | --- | --- |
| `extends` | No | Name of one parent profile in the same `profiles/` directory. Not ownership-qualified. |
| `harnesses` | Unless `extends` is set | Nonempty list of harnesses. |
| `template` | Unless `extends` is set | Template family Source ID. |
| `packs` | No | Ordered pack Source IDs. |
| `skills_enable` | No | Skills to enable in addition to pack-enabled skills. |
| `skills_disable` | No | Skills to exclude. |
| `budgets` | No | Same keys as the Source Repository root. |

### Extending a profile

```toml title="profiles/laptop.toml"
extends = "mac"
packs = ["ios"]
skills_enable = ["simulator"]
```

A profile may extend one parent, which may extend another. agentsmith merges the chain starting from the root ancestor:

| Key | Merge |
| --- | --- |
| `packs` | Parent packs, then child packs. A pack that appears twice anywhere in the chain is an error. |
| `skills_enable`, `skills_disable` | Ordered union, parent entries first. |
| `harnesses`, `template` | The child's value replaces the parent's when set. |
| `budgets` | Per key; the child's value wins. The result then overrides Source Repository defaults. |

Packs are additive only; a child cannot remove a parent's pack. A base profile may list only packs; the selected profile must end up with `harnesses` and `template`, set directly or inherited. Cycles and missing parents are errors. `asmith global explain` shows the resolved chain and which profile contributed each pack.

## Pack

Path, when needed: `<source>/packs/<name>/pack.toml` or `.config/agentsmith/packs/<name>/pack.toml`.

```toml
skills = ["to-issues", "address-review"]
```

A pack directory needs no manifest when it only contributes instructions or skill slots. Add `pack.toml` only to enable skills. When present, it accepts only the optional, ordered `skills` field; omitting `skills` is equivalent to an empty list.

## Project config

Path: `<project>/.config/agentsmith/config.toml`.

```toml
harnesses = ["codex", "claude"]

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

Harness names are `codex` and `claude`.

| Harness | Global instructions | Project instructions | Global skills | Project skills |
| --- | --- | --- | --- | --- |
| `codex` | `$CODEX_HOME/AGENTS.md` (normally `~/.codex/AGENTS.md`) | `<scope>/AGENTS.md` | `~/.agents/skills` | `<scope>/.agents/skills` |
| `claude` | `~/.claude/CLAUDE.md` | `<scope>/CLAUDE.md` | `~/.claude/skills` | `<scope>/.claude/skills` |

An existing `AGENTS.override.md` at a generated Codex layer is a preflight error because it would shadow `AGENTS.md`.

### Migrating from `claude-code`

The `claude-code` harness was renamed `claude`. Update `harnesses` values, rename `templates/<family>/claude-code.md` to `claude.md`, and rename `instructions/claude-code/` and `skill-slots/harnesses/claude-code/` pack directories to `claude/`. agentsmith reports an error for each leftover use of the old name instead of silently ignoring it.
