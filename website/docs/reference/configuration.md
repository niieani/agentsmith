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

[budgets.codex]
project_doc_bytes = 65536
```

All budget values are optional positive integers. The three top-level keys are UTF-8 byte thresholds that apply to every harness; they warn rather than truncate. A `[budgets.<harness>]` table overrides the [harness limits](#harness-limits) of one harness.

## Harness limits

agentsmith checks every selected harness against the limits that harness actually enforces, without any configuration. Each check models what the harness loads: the files in every directory from the repository root down to a scope, override files in place of the files they replace, and every skill the harness lists at a scope, including global skills and skills agentsmith did not write. The checks run in `lint`, `generate`, `sync`, and `add`.

| Harness | Key | What is measured | Default | Severity | Past the limit |
| --- | --- | --- | --- | --- | --- |
| `claude` | `instruction_file_lines` | each `CLAUDE.md` or `CLAUDE.local.md` agentsmith writes, with the files it `@import`s | 200 lines (recommended) | notice | Claude Code loads it all, but follows long files less reliably |
| `claude` | `on_demand_file_chars` | each nested `CLAUDE.md` or `CLAUDE.local.md` (a scope below the repository root), with its imports | 40,000 characters | warning | Claude Code reads only the start of a file it loads on demand |
| `claude` | `instruction_file_bytes` | each instruction file agentsmith writes | 4 MiB | error | Claude Code skips the file |
| `claude` | `import_depth` | `@import` hops from an instruction file agentsmith writes | 4 | error | Claude Code does not load deeper imports |
| `claude` | `skill_description_chars` | a skill's `description` plus `when_to_use` | 1,536 characters | warning | Claude Code truncates it in the skill listing |
| `claude` | `skill_listing_tokens` | every skill listed at a scope: name, description, and `when_to_use` | 2,000 tokens, estimated at 4 characters per token (about 1% of a 200K-token context window) | warning | Claude Code shortens or leaves out descriptions |
| `claude` | `skill_file_lines` | each `SKILL.md` | 500 lines (recommended) | notice | Claude Code loads it whole when the skill runs |
| `codex` | `project_doc_bytes` | the project `AGENTS.md` chain at a scope: one file per directory from the repository root, `AGENTS.override.md` counted instead of the `AGENTS.md` it replaces | 32 KiB | warning | Codex truncates the file that crosses the limit and skips every later file |
| `codex` | `skill_name_chars` | a skill's `name` | 64 characters | error | Codex fails to parse the skill and does not load it |
| `codex` | `skill_description_chars` | a skill's `description` | 1,024 characters | warning | Codex truncates it in its skill catalog |
| `codex` | `skill_listing_chars` | every skill description Codex reads at a scope, each counted up to `skill_description_chars` | 8,000 characters | warning | Codex drops descriptions from its catalog |

`generic` has no limits of its own; Codex's limits cover `.agents/` content because Codex reads it.

Each message names the harness, the file or scope, the measured size, the limit, what the harness does past it, and the key that overrides it, for example:

```text
WARNING codex-project-doc-bytes: Codex: the instruction files loaded at scope app (/repo/AGENTS.md, /repo/app/AGENTS.md) are 40,980 bytes, over the 32,768-byte limit for the project AGENTS.md chain (project_doc_max_bytes); Codex truncates the file that crosses the limit and skips every later file (budgets.codex.project_doc_bytes)
```

Diagnostic codes are `<harness>-<key>` with dashes, such as `claude-import-depth`. Token counts are estimates and say so. A `notice` never fails a run, even with `--warnings-as-errors`; warnings fail only with `--warnings-as-errors`; errors always fail.

Change a limit when you changed the harness, for example after raising Codex's `project_doc_max_bytes` or running Claude Code with a larger context window:

```toml
[budgets.codex]
project_doc_bytes = 65536     # matches project_doc_max_bytes = 65536 in ~/.codex/config.toml

[budgets.claude]
skill_listing_tokens = 10000  # 1% of a 1M-token context window
```

`[budgets.<harness>]` is accepted wherever `[budgets]` is: the Source Repository root, profiles, and the project config. Values merge per key like the other budgets. An unknown harness, a harness without limits (`generic`), an unknown key, or a value that is not a positive integer is a configuration error.

Assumptions the checks make: Claude Code starts at the repository root, so a nested scope's `CLAUDE.md` is loaded on demand; an `@path` outside code counts as an import only when the file exists; and a `CLAUDE.md` listed in `claudeMdExcludes` is not loaded.

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
| `budgets` | No | Same keys as the Source Repository root, including `[budgets.<harness>]`. |
| `exclusive` | No | `true` reports every skill agentsmith did not write. See [exclusive mode](#exclusive-mode). Default `false`. |
| `exclusive_allow` | No | Skill directory name globs that exclusive mode leaves alone. |
| `projects` | No | `[[projects]]` entries that configure [third-party repositories](#third-party-repositories). |

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
| `projects` | The child's entries first, then the parent's; the first matching entry wins. |
| `budgets` | Per key, and per key within each `[budgets.<harness>]`; the child's value wins. The result then overrides Source Repository defaults. |

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

Top-level project keys are `harnesses`, `claude_import_agents_md`, `budgets`, `exclusive`, `exclusive_allow`, `upstream`, and `scopes`. Scope keys are `path`, `template`, `packs`, `harnesses`, `skills_enable`, `skills_disable`, `harness_skills`, `exclusive`, and `exclusive_allow`. A `[scopes.harness_skills.<harness>]` table applies to the most recent `[[scopes]]` entry.

| Key | Default | Meaning |
| --- | --- | --- |
| `claude_import_agents_md` | `true` | When a scope's generated `CLAUDE.md` would be byte-identical to the `AGENTS.md` generated beside it, write `CLAUDE.md` containing only `@AGENTS.md`. Set `false` to always write the full content. |
| `exclusive` | `false` | Turn on [exclusive mode](#exclusive-mode) for every scope. A scope's own `exclusive` overrides it. |
| `exclusive_allow` | `[]` | Skill directory name globs that exclusive mode leaves alone. A scope's own list is added to this one. |
| `upstream` | unset | `"keep"` or `"replace"` marks a [third-party repository](#third-party-repositories): agentsmith writes only personal files. |

## Third-party repositories

Some repositories already commit their own `AGENTS.md`, `CLAUDE.md`, or skills, and you cannot or should not change them. Mark such a repository with `upstream`, and agentsmith never writes its committed files: every input is personal, and only the personal files and skills are written, all excluded through `.git/info/exclude`.

| `upstream` | `AGENTS.override.md` (Codex) | `CLAUDE.local.md` (Claude) | Upstream `CLAUDE.md` |
| --- | --- | --- | --- |
| `keep` (default) | upstream `AGENTS.md`, then your layer | your layer only | still loaded |
| `replace` | your layer only | your layer only | excluded through `claudeMdExcludes` |

With `keep`, a directory that has an upstream `AGENTS.md` but no `CLAUDE.md` gets `@AGENTS.md` at the top of `CLAUDE.local.md`, because a `CLAUDE.local.md` turns off Claude's fallback to `AGENTS.md`. Upstream skills stay visible; one with the same name as a generated skill is an error. Generic tools keep reading the upstream `AGENTS.md`.

You can put `upstream` in a `.config/agentsmith/config.toml` you add to the repository yourself; agentsmith excludes `/.config/agentsmith/` through `.git/info/exclude` so it stays out of `git status`. Without any project config, add an entry to your profile instead:

```toml title="profiles/laptop.toml"
[[projects]]
remote = "github.com/acme/tool"   # matches git@github.com:acme/tool.git, https://github.com/acme/tool, ...
upstream = "replace"
packs = ["base", "review"]
template = "personal"

[[projects]]
path = "~/src/vendor-sdk"
packs = ["base"]
template = "personal"
```

| Key | Default | Meaning |
| --- | --- | --- |
| `path` or `remote` | required, exactly one | The repository root, or any of its remote URLs. Remotes compare by host and path, ignoring the scheme, user, and `.git`. |
| `upstream` | `"keep"` | As in the table above. |
| `harnesses` | the profile's | Harnesses for this repository. |
| `template`, `packs`, `skills_enable`, `skills_disable` | none | As in a project scope at `.`. Source IDs cannot be `project:`-qualified. |

`asmith project generate`, `diff`, `lint`, `explain`, and `clean` use the first matching entry when they find no `.config/agentsmith/config.toml`.

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

Adding a personal snippet or pack never changes the shared layer, so teammates never see your personal instructions in a diff. A Source Repository partial included by a project template renders as nothing in the shared layer. When the template itself comes from the Source Repository, no shared file is written and only the personal files carry the scope's instructions. To commit such a template with the project, copy it into `.config/agentsmith/` with [`asmith project init --template NAME`](/reference/commands#copying-a-template-into-the-project), which sets `template = "project:NAME"`.

Skills are not layered. Shared and personal skills are generated into the same skill roots, which `asmith project init` adds to `.gitignore`.

### Migrating to the `.agents` layout

Earlier versions wrote Codex skills to `.agents/skills` and `~/.agents/skills` under the `codex` harness. Add `generic` to `harnesses` to keep those destinations; with `codex` alone, project skills move to `.codex/skills` and global skills are an error. Pack directories named `instructions/generic/` or `skill-slots/harnesses/generic/`, and a `generic.md` template, are now harness-specific.

### Migrating from `claude-code`

The `claude-code` harness was renamed `claude`. Update `harnesses` values, rename `templates/<family>/claude-code.md` to `claude.md`, and rename `instructions/claude-code/` and `skill-slots/harnesses/claude-code/` pack directories to `claude/`. agentsmith reports an error for each leftover use of the old name instead of silently ignoring it.
