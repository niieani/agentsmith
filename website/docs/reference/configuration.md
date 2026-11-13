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
| `exclusive` | No | `true` reports every skill agentsmith did not write. See [exclusive mode](#exclusive-mode). Default `false`. |
| `exclusive_allow` | No | Skill directory name globs that exclusive mode leaves alone. |

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
| `harnesses`, `template`, `exclusive` | The child's value replaces the parent's when set. |
| `exclusive_allow` | Ordered union, parent entries first. |
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

Top-level project keys are `harnesses`, `claude_import_agents_md`, `budgets`, `exclusive`, `exclusive_allow`, and `scopes`. Scope keys are `path`, `template`, `packs`, `harnesses`, `skills_enable`, `skills_disable`, `harness_skills`, `exclusive`, and `exclusive_allow`. A `[scopes.harness_skills.<harness>]` table applies to the most recent `[[scopes]]` entry.

| Key | Default | Meaning |
| --- | --- | --- |
| `claude_import_agents_md` | `true` | When a scope's generated `CLAUDE.md` would be byte-identical to the `AGENTS.md` generated beside it, write `CLAUDE.md` containing only `@AGENTS.md`. Set `false` to always write the full content. |
| `exclusive` | `false` | Turn on [exclusive mode](#exclusive-mode) for every scope. A scope's own `exclusive` overrides it. |
| `exclusive_allow` | `[]` | Skill directory name globs that exclusive mode leaves alone. A scope's own list is added to this one. |

## Exclusive mode

```toml
exclusive = true
exclusive_allow = ["find-skills", "vercel-*"]
```

With exclusive mode on, agentsmith expects to own every skill a selected harness can see in the scope being generated. It checks every Skill Root that a selected harness reads, globally or in each exclusive project scope (for example `~/.agents/skills`, `~/.codex/skills`, and `~/.claude/skills`), and reports each skill directory it did not write. Directories whose name matches an `exclusive_allow` glob are left alone, which suits skills that another tool installs, such as `npx skills add`. Hidden directories, such as Codex's `.system`, are skipped.

Globs match the whole directory name: `*` matches any run of characters, `?` one character, and `[ab]` or `[!ab]` one character from, or not from, a set.

Unmanaged skills make `lint`, `generate`, and `sync` exit 5 and list each path. With `--on-modified=backup` they move to the backup folder and the run continues: globally `~/.agents/agentsmith/backups/<UTC timestamp>/<original path>`, in a project `<Git directory>/agentsmith/backups/<UTC timestamp>/<original path>`. To keep an unmanaged skill, adopt it with [`adopt --skill`](/reference/commands#adopting-unmanaged-skills).

In a profile, `exclusive` follows `extends` like `harnesses`: the nearest profile that sets it wins. `exclusive_allow` lists merge as an ordered union. In a project, `exclusive` and `exclusive_allow` at the top level apply to every scope; a scope's `exclusive` overrides the top-level value, and its `exclusive_allow` adds to the top-level list.

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

Source IDs are slash-separated logical names, not filesystem paths. Unqualified names are preferred. In project mode, templates, skills, and partials resolve project-first with Source Repository fallback; packs compose Source Repository and project matches in that order. `source:` and `project:` restrict resolution to one owner. Global profiles resolve only Source Repository sources and reject `project:` references. A name missing from every eligible owner is an error, except in a project without a machine config: then a name the project does not provide is skipped with a notice (see [projects without a Source Repository](#projects-without-a-source-repository)).

### Projects without a Source Repository

A fresh clone, a CI job, or a teammate without agentsmith set up has no machine config. `asmith project generate` still renders everything shared inputs define, and skips each personal input with a `NOTICE personal-input-skipped` line: Source Repository packs (with their snippets and skills), skills, templates, and partials. A project skill whose required slot only a skipped pack fills is skipped with a warning; an empty optional slot renders empty. A missing `project:`-qualified source is still an error. Notices never fail a run, even with `--warnings-as-errors`.

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

Codex reads `AGENTS.override.md` instead of `AGENTS.md`. agentsmith writes that file for the [personal layer](#shared-and-personal-layers); an `AGENTS.override.md` it did not write is a preflight error because it would shadow the generated `AGENTS.md`.

### Shared and personal layers

In a project, what is committed depends on where each input lives, not on which file it ends up in:

- **Shared inputs** live in the project's own `.config/agentsmith/` tree: its templates, packs, skills, and partials, except `*.local.md` files.
- **Personal inputs** are everything else: Source Repository templates, packs, skills, and partials, and the project's `*.local.md` snippets and partials.

Every project Instruction Layer is rendered twice:

| Layer | Rendered from | Files | Committed |
| --- | --- | --- | --- |
| Shared | shared inputs only | `<scope>/AGENTS.md`, `<scope>/CLAUDE.md` (or `@AGENTS.md`) | yes |
| Personal | every input | `<scope>/AGENTS.override.md` for `codex`, `<scope>/CLAUDE.local.md` for `claude` | no, excluded through `.git/info/exclude` |

The personal files are written only when they differ from the shared layer. Codex reads `AGENTS.override.md` instead of `AGENTS.md`. For Claude, agentsmith adds `<scope>/CLAUDE.md` to `claudeMdExcludes` in `<project>/.claude/settings.local.json`, so Claude loads only `CLAUDE.local.md` for that folder. agentsmith owns only the `claudeMdExcludes` entries it added and keeps every other setting. `generic` has no personal file; other agents read the shared `AGENTS.md`.

Adding a personal snippet or pack never changes the shared layer, so teammates never see your personal instructions in a diff. A Source Repository partial included by a project template renders as nothing in the shared layer. When the template itself comes from the Source Repository, no shared file is written and only the personal files carry the scope's instructions.

Skills are not layered. Shared and personal skills are generated into the same skill roots, which `asmith project init` adds to `.gitignore`.

### Migrating to the `.agents` layout

Earlier versions wrote Codex skills to `.agents/skills` and `~/.agents/skills` under the `codex` harness. Add `generic` to `harnesses` to keep those destinations; with `codex` alone, project skills move to `.codex/skills` and global skills are an error. Pack directories named `instructions/generic/` or `skill-slots/harnesses/generic/`, and a `generic.md` template, are now harness-specific.

### Migrating from `claude-code`

The `claude-code` harness was renamed `claude`. Update `harnesses` values, rename `templates/<family>/claude-code.md` to `claude.md`, and rename `instructions/claude-code/` and `skill-slots/harnesses/claude-code/` pack directories to `claude/`. agentsmith reports an error for each leftover use of the old name instead of silently ignoring it.
