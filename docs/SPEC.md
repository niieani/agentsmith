# agentsmith v1 specification

## 1. Names and paths

- Project: `agentsmith`
- CLI: `asmith`
- Machine configuration: `~/.agents/agentsmith/config.toml`
- Project configuration: `.config/agentsmith/config.toml`
- Project state: stored under the worktree's actual Git directory, never in generated artifacts
- Global state: `~/.agents/agentsmith/state.toml`

CLI flags may override the machine or project configuration path. A leading `~` in configured paths expands to the current home directory. Other relative paths resolve against the file containing them. Environment variables and shell expressions are not interpolated.

## 2. Source Repository layout

```text
agentsmith.toml
profiles/
  studio.toml
templates/
  software/
    default.md
    codex.md
    claude-code.md
packs/
  github/
    pack.toml
    instructions/
      git/
        10-common.md
      codex/
        tools/
          20-codex.md
    skill-slots/
      tracker/
        10-github.md
      harnesses/
        claude-code/
          tracker/
            20-claude.md
skills/
  to-issues/
    SKILL.md
    references/
      conventions.md
partials/
  grilling/
    core.md
```

Project-owned sources mirror `templates/`, `packs/`, `skills/`, and `partials/` beneath `.config/agentsmith/`.

Scans reject symlinks. Markdown conventions include every `.md` file, including ignored `*.local.md`. Within a selected pack, paths sort by deterministic Unicode lexical order. Pack order always precedes filename order.

## 3. Source IDs

An unqualified Source ID resolves only from the Source Repository:

```toml
template = "software"
packs = ["base", "bun", "github"]
skills_enable = ["to-issues"]
```

A Source ID beginning with `@project/` resolves only from project-owned source:

```toml
template = "@project/custom"
packs = ["base", "@project/deploy"]
skills_enable = ["@project/release"]
```

Source IDs use forward-slash logical segments, not arbitrary paths. Empty segments, `.`, `..`, absolute paths, backslashes, NUL, and root escape are invalid.

For skills, Source ID and public Skill Name are separate. `@project/release` resolves a source directory; the emitted name comes from that source's `SKILL.md` front matter and must equal the source directory basename.

## 4. Configuration schema

Every TOML document is strict and contains `version = 1`. Unknown keys, wrong types, duplicate selected packs, unknown harnesses, and missing referenced sources are errors.

### 4.1 Machine configuration

```toml
version = 1
source = "~/.agents/agentsmith/source"
profile = "studio"
```

### 4.2 Source Repository root

```toml
version = 1

[budgets]
instruction_layer_bytes = 24576
effective_instruction_bytes = 32768
skill_markdown_bytes = 16384
```

All budget keys are optional positive UTF-8 byte thresholds.

### 4.3 Profile

`profiles/studio.toml`:

```toml
version = 1
harnesses = ["codex", "claude-code"]
template = "personal"
packs = ["base", "personal", "macos", "server"]
skills_enable = ["review-worktree"]
skills_disable = ["publish"]

[budgets]
effective_instruction_bytes = 28672
```

Profile budgets override matching Source Repository defaults.

### 4.4 Pack

`packs/github/pack.toml`:

```toml
version = 1
skills = ["to-issues", "address-review"]
```

`skills` is ordered and optional. v1 has no pack dependencies, conflicts, conditions, or implicit pack inclusion.

### 4.5 Project configuration

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

[[scopes]]
path = "services/api"
packs = ["service"]
```

The project root is the directory containing `.config/agentsmith/config.toml`. Scope paths are unique, normalized, existing project-relative directories that may not escape the project. A harness override must be a nonempty subset of the project defaults.

Omitting `template` means the scope emits no Instruction Layer. Omitting skill lists does not by itself prevent packs from enabling skills. A Skill Root is created only when at least one skill is introduced at that scope.

Scope ancestry derives from normalized paths. Each Scope Pack Selection is a delta; inherited packs are not repeated.

## 5. Template families and harnesses

For template Source ID `software`, resolution checks:

```text
templates/software/<harness>.md
templates/software/default.md
```

The harness-specific template wins; `default.md` is the fallback. Absence of both is an error.

### 5.1 Codex adapter

| Artifact | Global destination | Scoped destination |
|---|---|---|
| Instruction Layer | `$CODEX_HOME/AGENTS.md`, default `~/.codex/AGENTS.md` | `<scope>/AGENTS.md` |
| Skill Root | `~/.agents/skills` | `<scope>/.agents/skills` |

An existing `AGENTS.override.md` at a generated layer is a hard preflight error because it shadows `AGENTS.md`. The adapter models global then repository-to-working-directory instruction order. It warns when a project instruction chain exceeds Codex's documented default 32 KiB cap and labels the cap as configurable.

### 5.2 Claude Code adapter

| Artifact | Global destination | Scoped destination |
|---|---|---|
| Instruction Layer | `~/.claude/CLAUDE.md` | `<scope>/CLAUDE.md` |
| Skill Root | `~/.claude/skills` | `<scope>/.claude/skills` |

The adapter models ancestor discovery and nested on-demand discovery. agentsmith does not emit native `@` imports; generated Claude artifacts are flat and self-contained.

### 5.3 Physical destination collisions

If adapters plan the same physical destination, agentsmith coalesces byte-identical content into one write. Different content for the same destination is a planning error.

## 6. Directives

Recognized directives must begin at column zero, occupy the complete line, and occur outside a CommonMark fenced code block.

```md
<!-- agentsmith:slot tools -->
<!-- agentsmith:required-slot verification -->
<!-- agentsmith:include grilling/core.md -->
<!-- agentsmith:include @project/domain/terms.md -->
```

Names use logical Source ID syntax. Unknown or malformed `agentsmith:` directives are errors. Directives remaining in generated output are errors.

### 6.1 Slots

- A template or skill may declare a slot name at most once.
- `slot` disappears when no snippets contribute.
- `required-slot` fails when no snippets contribute.
- A selected instruction contribution whose slot is absent from the receiving Instruction Layer is an error.
- A selected skill-slot contribution is inserted into every enabled skill that declares its slot.
- A selected skill-slot contribution that matches no enabled skill is a warning.
- Contributions for a scope with no Instruction Layer are warnings.

Instruction snippets for pack `github` and slot `tools` are discovered in this order:

1. `packs/github/instructions/tools/*.md`
2. `packs/github/instructions/<harness>/tools/*.md`

Reusable skill snippets for slot `tracker` are discovered in this order:

1. `packs/github/skill-slots/tracker/*.md`
2. `packs/github/skill-slots/harnesses/<harness>/tracker/*.md`

Skill-slot contributions are keyed only by slot name, never by consuming skill name. The same snippet may therefore be rendered into multiple enabled skills. Skill sources and contributing packs may have different owners: for example, an `@project/tracker` pack may fill `tracker` slots in shared skills.

A `skills/<skill>/<slot>/` directory inside a pack is invalid because it couples the provider to a consumer. Planning fails with a migration diagnostic directing the author to `skill-slots/<slot>/`.

Across packs, the Scope Pack Selection order is primary.

### 6.2 Includes

- Includes resolve only beneath the selected source root's `partials/` directory.
- Unqualified includes resolve from the Source Repository.
- `@project/...` includes resolve from project partials.
- No fallback or shadowing occurs between roots.
- Missing files, cycles, root escape, and symlinks are errors.
- Includes expand recursively before slot filling.

### 6.3 Heading rebasing

Only column-zero ATX headings are structural. Setext headings in partials are errors. Fenced-code headings are ignored.

A body-only partial inserts verbatim. A headed partial must begin with H1. At the include occurrence, its H1 becomes one level below the nearest preceding rendered ATX heading; all relative heading depths are preserved. Absence of a parent or a result deeper than H6 is an error.

Snippet headings are not rewritten. Lint warns when a snippet's first structural heading is at or above the heading surrounding its slot.

## 7. Skill planning and generation

For one scope, enabled skill Source IDs are the stable ordered union of:

1. skills enabled by selected packs, in pack order;
2. `skills_enable` entries;
3. minus `skills_disable` entries.

Repeated enablement of the same Source ID is idempotent. Exclusion affects only skills introduced by that scope; it cannot hide inherited skills.

Every skill source is a directory containing `SKILL.md`. All Markdown files pass through include and slot rendering. Non-Markdown files copy unchanged, including executable mode. A common skill source is rendered for each harness, with optional harness-specific pack snippets.

The public Skill Name is parsed from `SKILL.md` YAML front matter. Only the Agent Skills metadata is parsed; snippets and partials do not use front matter. The `name` and `description` fields are required, and `name` must equal the source directory basename.

### 7.1 Collision policy

- A public Skill Name may be emitted at only one visible scope along any effective chain.
- Different Source IDs declaring the same public name are errors.
- A planned skill colliding with a visible unmanaged filesystem skill is an error.
- Two unmanaged visible skills colliding with each other produce a warning.
- Malformed or unreadable unmanaged `SKILL.md` produces a warning.
- Plugin, admin, bundled, and otherwise undiscoverable external skills are out of scope.
- When machine configuration is available, project checks include generated personal skills. Hermetic checks state that only project scopes were analyzed.

## 8. Planning, state, and writes

All mutating commands create a Generation Plan containing writes and stale deletions. The tool renders, validates, checks collisions, evaluates budgets, and preflights every destination before changing the filesystem.

### 8.1 Project safety

Project generation requires every destination to belong to the same Git worktree as the project configuration. Nested independent repositories in one plan are unsupported.

- Missing destinations are allowed.
- Existing tracked-clean destinations may be replaced.
- Modified, staged, conflicted, untracked, or ignored destinations fail the entire plan.
- There is no force option.

agentsmith records the paths it generated beneath the worktree's actual Git directory. Previously recorded paths absent from the next plan become stale deletions. A stale path is deleted only when Git reports it clean. Unrecorded paths are never deleted.

### 8.2 Global safety

Global state records destination paths and content hashes outside generated artifacts.

- A missing destination may be created.
- An existing unrecorded destination requires `--force` for initial adoption.
- A recorded destination may be replaced only when its current content matches recorded state.
- `--force` is limited to global generate/sync adoption or recovery.
- Stale recorded artifacts are deleted only when unchanged from recorded state.

### 8.3 Application

Writes use same-filesystem temporary paths and atomic rename. Before application, previous content is backed up. If any application step fails, agentsmith restores the prior artifact set and state file.

## 9. Git synchronization

`global sync` requires the Source Repository to be a Git worktree with an upstream. It rejects tracked, staged, conflicted, and nonignored untracked changes. Ignored local source is permitted. It runs:

```sh
git pull --ff-only
```

The command is noninteractive and propagates missing-upstream, detached-head, authentication, conflict, and non-fast-forward failures without generating.

Other global commands perform no Git synchronization. Project commands never synchronize.

## 10. Budgets

Supported optional positive UTF-8 byte warning thresholds:

- `instruction_layer_bytes`
- `effective_instruction_bytes`
- `skill_markdown_bytes`

Effective instruction size is evaluated for every declared scope chain and harness. Skill Markdown size includes rendered Markdown files but excludes copied support files; explain reports support-file bytes separately.

Budgets warn and never truncate. `lint --warnings-as-errors` turns warnings into failure for CI. Source Repository budgets cascade to global profiles; project budgets stand alone.

## 11. CLI

```text
asmith global sync [--config PATH] [--force]
asmith global generate [--config PATH] [--force]
asmith global diff [--config PATH]
asmith global lint [--config PATH] [--warnings-as-errors]
asmith global explain [--config PATH] [--json]

asmith project generate [--project PATH]
asmith project diff [--project PATH]
asmith project lint [--project PATH] [--warnings-as-errors]
asmith project explain [--project PATH] [--json]
```

`project` walks from the requested path, or current directory, toward its ancestors to find `.config/agentsmith/config.toml`.

Exit status is nonzero for configuration, validation, planning, preflight, synchronization, or application errors. Warnings alone succeed unless `--warnings-as-errors` is active.

## 12. Determinism

- Explicit pack order is preserved.
- All other scans use deterministic Unicode lexical path order.
- Generated Markdown uses LF and exactly one terminal newline.
- Non-Markdown bytes remain unchanged.
- Rendered output contains no agentsmith directives.
- Repeating generation over unchanged source produces an empty diff.

## 13. Discovery references

The built-in adapters are based on the harness vendors' documented behavior:

- [Codex custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Codex Agent Skills](https://developers.openai.com/codex/build-skills)
- [Claude Code project memory and CLAUDE.md](https://code.claude.com/docs/en/memory)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
