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
| `home` | No | Sandbox home. See [sandbox home](#sandbox-home). |

Relative paths resolve against the directory holding the config file; `~` means your real home.

### Sandbox home

```toml title="~/sandbox/config.toml"
source = "source"
profile = "laptop"
home = "home"
```

When `home` is set, agentsmith uses it in place of `$HOME` for everything it owns: global artifacts (`<home>/.claude/CLAUDE.md`, `<home>/.codex/AGENTS.md`, `<home>/.agents/skills`, …), `state.toml`, `status.json`, stored content blobs, backups, and scheduler logs, all under `<home>/.agents/agentsmith/`. `CODEX_HOME` is ignored while `home` is set, so a sandbox never writes into your real `~/.codex`. The directory must already exist.

Git and SSH still run with your real `$HOME`, so your identity, keys, and credential helpers keep working for `global sync`, `global add --push`, and `global init`. Pass the config with `--config` to every global command, including `global status`. `global schedule install --config` schedules a job that syncs the sandbox; the LaunchAgent or systemd unit itself stays in your real home. `global init --config` keeps an existing config's `home` and, without `--source`, clones into `<home>/.agents/agentsmith/source`.

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
harnesses = ["generic", "codex", "claude"]
template = "personal"
packs = ["base", "personal", "macos"]
skills_enable = ["review-worktree"]
skills_disable = ["publish"]

[harness_skills.claude]
enable = ["claude-hooks"]

[budgets]
effective_instruction_bytes = 28672
```

Profile budgets override matching Source Repository defaults. See [per-harness skills](#per-harness-skills) for `harness_skills`.

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
| `harness_skills.<harness>.enable`, `.disable` | Ordered union per harness, parent entries first. Each configured harness must be selected by the resolved profile. |
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
harnesses = ["generic", "codex", "claude"]
claude_import_agents_md = true

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

[scopes.harness_skills.codex]
disable = ["publish"]
```

Top-level project keys are `harnesses`, `claude_import_agents_md`, `budgets`, and `scopes`. Scope keys are `path`, `template`, `packs`, `harnesses`, `skills_enable`, `skills_disable`, and `harness_skills`. A `[scopes.harness_skills.<harness>]` table applies to the most recent `[[scopes]]` entry.

| Key | Default | Meaning |
| --- | --- | --- |
| `claude_import_agents_md` | `true` | When a scope's generated `CLAUDE.md` would be byte-identical to the `AGENTS.md` generated beside it, write `CLAUDE.md` containing only `@AGENTS.md`. Set `false` to always write the full content. |

## Per-harness skills

`skills_enable` and `skills_disable` apply to every harness the profile or scope selects. A `harness_skills` table adjusts one harness:

```toml
skills_enable = ["review"]

[harness_skills.claude]
enable = ["claude-hooks"]
disable = ["review"]
```

For each selected harness, the enabled skills are the pack skills plus `skills_enable`, minus `skills_disable`, plus that harness's `enable`, minus its `disable`. Harness lists apply last, so a harness `enable` can restore a skill that `skills_disable` removed.

Each `harness_skills.<harness>` table accepts only `enable` and `disable`. Unknown harnesses, harnesses the profile or scope does not select, and a skill listed in both `enable` and `disable` are errors. An unused harness `disable` entry is a warning. In a project, write the table as `[scopes.harness_skills.<harness>]` below its `[[scopes]]` entry.

## Source IDs

Source IDs are slash-separated logical names, not filesystem paths. Unqualified names are preferred. In project mode, templates, skills, and partials resolve project-first with Source Repository fallback; packs compose Source Repository and project matches in that order. `source:` and `project:` restrict resolution to one owner. Global profiles resolve only Source Repository sources and reject `project:` references. A name missing from every eligible owner is an error.

## Harness destinations

Harness names are `generic`, `codex`, and `claude`. `generic` targets the shared `.agents/` convention that Codex and other agents read. See [harness discovery](/reference/harness-discovery) for what each harness reads and why.

| Harness | Global instructions | Project instructions | Global skills | Project skills |
| --- | --- | --- | --- | --- |
| `generic` | none | `<scope>/AGENTS.md` | `~/.agents/skills` | `<scope>/.agents/skills` |
| `codex` | `$CODEX_HOME/AGENTS.md` (normally `~/.codex/AGENTS.md`) | `<scope>/AGENTS.md` | none; use `generic` | `<scope>/.codex/skills`, only for skills not enabled for `generic` |
| `claude` | `~/.claude/CLAUDE.md` | `<scope>/CLAUDE.md` | `~/.claude/skills` | `<scope>/.claude/skills` |

### Shared `AGENTS.md`

`generic` and `codex` write the same `<scope>/AGENTS.md`, so agentsmith renders it once. It uses `templates/<family>/codex.md` when `codex` is selected, otherwise `generic.md`, otherwise `default.md`. Common snippets render first, then `instructions/generic/` snippets when `generic` is selected, then `instructions/codex/` snippets when `codex` is selected.

### Skill placement

Codex reads both `.agents/skills` and `.codex/skills` and keeps every copy, so one skill name visible twice breaks `$name` mentions. agentsmith writes each skill once per root:

- A skill enabled for `generic` goes to `.agents/skills` (or `~/.agents/skills`) and also serves Codex. It renders only common skill-slot content. Codex-specific `skill-slots/harnesses/codex/` content consumed by that skill is an error, because Codex would read the common copy.
- A skill enabled for `codex` but not `generic` goes to `<scope>/.codex/skills` with Codex content. In a global profile this is an error: enable the skill for `generic`.
- A skill enabled for `claude` goes to the Claude root with Claude content.

Harness-specific content renders only where exactly one harness reads the skill. Collision checks consider every root each selected harness reads, so a planned or unmanaged skill in `.codex/skills` collides with one of the same name in `.agents/skills` when `codex` is selected.

An existing `AGENTS.override.md` at a generated Codex layer is a preflight error because it would shadow `AGENTS.md`.

### Migrating to the `.agents` layout

Earlier versions wrote Codex skills to `.agents/skills` and `~/.agents/skills` under the `codex` harness. Add `generic` to `harnesses` to keep those destinations; with `codex` alone, project skills move to `.codex/skills` and global skills are an error. Pack directories named `instructions/generic/` or `skill-slots/harnesses/generic/`, and a `generic.md` template, are now harness-specific.

### Migrating from `claude-code`

The `claude-code` harness was renamed `claude`. Update `harnesses` values, rename `templates/<family>/claude-code.md` to `claude.md`, and rename `instructions/claude-code/` and `skill-slots/harnesses/claude-code/` pack directories to `claude/`. agentsmith reports an error for each leftover use of the old name instead of silently ignoring it.
