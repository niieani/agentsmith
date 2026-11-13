# agentsmith v1 specification

## 1. Names and paths

- Project: `agentsmith`
- CLI: `asmith`
- Machine configuration: `~/.agents/agentsmith/config.toml`
- Project configuration: `.config/agentsmith/config.toml`
- Project state: stored under the worktree's actual Git directory, never in generated artifacts
- Personal project files: `<scope>/AGENTS.override.md`, `<scope>/CLAUDE.local.md`, excluded through the repository's `info/exclude`, plus `claudeMdExcludes` entries in `<project>/.claude/settings.local.json`
- Global state: `~/.agents/agentsmith/state.toml`
- Stored global artifact content: `~/.agents/agentsmith/blobs/<sha256>`
- Last global run status: `~/.agents/agentsmith/status.json`
- Default Source Repository clone for `global init`: `~/.agents/agentsmith/source`
- Scheduled sync logs (macOS): `~/.agents/agentsmith/logs/`

CLI flags may override the machine or project configuration path. A leading `~` in configured paths expands to the current home directory. Other relative paths resolve against the file containing them. Environment variables and shell expressions are not interpolated.

## 2. Source Repository layout

```text
agentsmith.toml
profiles/
  studio.toml
templates/
  software/
    default.md
    generic.md
    codex.md
    claude.md
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
        claude/
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

Scans reject symlinks. The home directory, project root, and Source Repository root are canonicalized with `realpath` when loaded, so symlinked ancestors above them (macOS `/var`, Fedora Atomic `/home`) compare equal to Git's paths; destinations below those roots keep their spelling, and a symlink at or above a destination but below its root is rejected. Markdown conventions include every `.md` file, including ignored `*.local.md`. Within a selected pack, paths sort by deterministic Unicode lexical order. Pack order always precedes filename order.

## 3. Source IDs

An unqualified Source ID is the default:

```toml
template = "software"
packs = ["base", "bun", "github"]
skills_enable = ["to-issues"]
```

During project generation, templates, skills, and partials resolve from project-owned source first, then fall back to the Source Repository. Packs compose both matches in Source Repository then project order. Ownership qualifiers restrict lookup when needed:

```toml
template = "source:software"
packs = ["base", "project:deploy"]
skills_enable = ["project:release"]
```

Source IDs use forward-slash logical segments, not arbitrary paths. Empty segments, `.`, `..`, absolute paths, backslashes, NUL, and root escape are invalid.

Global generation resolves only from the Source Repository and rejects `project:` references. Missing names are errors, except as section 3.1 describes. For skills, Source ID and public Skill Name are separate. `project:release` resolves a source directory; the emitted name comes from that source's `SKILL.md` front matter and must equal the source directory basename.

### 3.1 Project generation without a Source Repository

Without a machine configuration, project commands render what shared inputs define and skip personal inputs instead of failing. A Source ID that is not `project:`-qualified and that no project-owned source provides (an unqualified name, or any `source:` reference) is skipped, with one `personal-input-skipped` notice per Source ID:

- a pack contributes no instruction or skill-slot snippets and enables no skills;
- a skill is not generated, and an exclusion naming it is not reported as inactive;
- a template leaves the scope's Instruction Layer unwritten;
- a partial's include renders as nothing (one adjacent blank line is dropped).

A skill whose required slot is then empty is skipped with the warning `skill-skipped-required-slot`, and an Instruction Layer whose required slot is empty is skipped with `instruction-layer-skipped-required-slot`; with a Source Repository both stay `required-slot-empty` errors. An empty optional slot renders empty. A missing `project:` source is still an error. Project `*.local.md` snippets still render, so the personal layer may still differ from the shared layer.

The shared layer (section 5.5) applies the same rules whether or not a Source Repository is configured, without notices.

## 4. Configuration schema

Every TOML document is strict. Configuration files have no schema-version field; `version` and all other unknown keys are errors. Wrong types, duplicate selected packs, unknown harnesses, and missing referenced sources are also errors.

### 4.1 Machine configuration

```toml
source = "~/.agents/agentsmith/source"
profile = "studio"
home = "~/sandbox/home"   # optional
```

`source` and `home` resolve relative to the configuration file; `~` and `~/` expand to the real home directory. `home`, when set, must be an existing directory and is canonicalized (symlinked ancestors resolved). It replaces `$HOME` for every agentsmith destination and every piece of agentsmith state: global Instruction Layers and Skill Roots, the Codex home (`<home>/.codex`; `CODEX_HOME` is ignored), `state.toml`, `status.json`, `blobs/`, `backups/`, and `logs/` under `<home>/.agents/agentsmith/`. Project plans that read the machine configuration use the same home for global collision checks. Git and other subprocesses inherit the real environment, including `$HOME`. Commands that only need state (`global status`, run status recording, `global schedule status`) read `home` leniently, so they still find the sandbox when the rest of the configuration is invalid; an unreadable `home` falls back to the real home. `global clean` instead fails with a configuration error when the configuration exists but is unreadable or its `home` is invalid, so it never cleans the real home by mistake.

### 4.2 Source Repository root

```toml
[budgets]
instruction_layer_bytes = 24576
effective_instruction_bytes = 32768
skill_markdown_bytes = 16384
```

All budget keys are optional positive UTF-8 byte thresholds.

### 4.3 Profile

`profiles/studio.toml`:

```toml
harnesses = ["generic", "codex", "claude"]
template = "personal"
packs = ["base", "personal", "macos", "server"]
skills_enable = ["review-worktree"]
skills_disable = ["publish"]

[harness_skills.claude]
enable = ["claude-hooks"]
disable = ["review-worktree"]

[budgets]
effective_instruction_bytes = 28672
```

Profile budgets override matching Source Repository defaults. `harness_skills` is described in section 7.

A profile may set `extends = "<profile name>"` to inherit from one parent profile; the parent may extend another. Parent names follow profile-name rules and cannot be ownership-qualified. Any profile may omit `harnesses` or `template`; the selected profile must resolve both, directly or through its chain. The chain is merged root ancestor first:

- `packs`: parent packs, then child packs. A pack repeated anywhere in the chain is an error. Packs are additive only; there is no way to remove an inherited pack.
- `skills_enable`, `skills_disable`: ordered union.
- `harness_skills.<harness>.enable` and `.disable`: ordered union per harness; every configured harness must be in the resolved `harnesses`.
- `harnesses`, `template`: the nearest profile that sets the value wins.
- `budgets`: per key, child wins; the merged result then overrides Source Repository defaults.

Profiles accept `exclusive` (boolean, default `false`; the nearest profile that sets it wins) and `exclusive_allow` (a list of skill directory name globs; ordered union through the chain). See section 7.3.

A profile may declare `[[projects]]` entries that configure third-party repositories without an agentsmith configuration of their own (section 5.6):

```toml
[[projects]]
remote = "github.com/acme/tool"   # or: path = "~/src/tool"
upstream = "keep"                 # default; or "replace"
harnesses = ["codex", "claude"]   # default: the profile's harnesses
template = "personal"
packs = ["base"]
skills_enable = []
skills_disable = []
```

Each entry sets exactly one of `path` (resolved like other configured paths and canonicalized) and `remote`, and accepts only the keys shown. Source IDs may not be `project:`-qualified. Entries are listed nearest profile first through `extends`; the first matching entry wins.

An `extends` cycle or a missing parent profile is an error. `global explain` reports the resolved chain (`profile.chain`, root first) and the profile that contributed each pack (`profile.packs`).

### 4.4 Pack

Pack directories are valid without a manifest. Add `pack.toml` only when the pack enables skills:

```toml
skills = ["to-issues", "address-review"]
```

When present, `pack.toml` accepts only the optional, ordered `skills` field. Omitting it normalizes to an empty list. v1 has no pack dependencies, conflicts, conditions, or implicit pack inclusion.

### 4.5 Project configuration

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

[[scopes]]
path = "services/api"
packs = ["service"]
```

The project root is the directory containing `.config/agentsmith/config.toml`. Scope paths are unique, normalized, existing project-relative directories that may not escape the project. A harness override must be a nonempty subset of the project defaults. `claude_import_agents_md` is an optional boolean, default `true` (section 5.3).

`upstream = "keep" | "replace"` at the top level marks a third-party repository (section 5.6). Without it, the project owns its shared layer.

`exclusive` and `exclusive_allow` are accepted at the top level and in each scope. A scope's `exclusive` overrides the top-level value (default `false`); its `exclusive_allow` is appended to the top-level list. See section 7.3.

Omitting `template` means the scope emits no Instruction Layer. Omitting skill lists does not by itself prevent packs from enabling skills. A Skill Root is created only when at least one skill is introduced at that scope.

Scope ancestry derives from normalized paths. Each Scope Pack Selection is a delta; inherited packs are not repeated.

## 5. Template families and harnesses

For template Source ID `software`, resolution checks:

```text
templates/software/<harness>.md
templates/software/default.md
```

The harness-specific template wins; `default.md` is the fallback. Absence of both is an error.

Harness names are `generic`, `codex`, and `claude`. Each adapter declares its write destinations and every skill root the harness reads; placement, content, and collision rules are computed from that data. The discovery facts behind these tables are in the [harness discovery reference](../website/docs/reference/harness-discovery.md).

### 5.1 Generic adapter

`generic` targets the shared `.agents/` convention. It is not a runtime; Codex and other agents read its roots.

| Artifact | Global destination | Scoped destination |
|---|---|---|
| Instruction Layer | none | `<scope>/AGENTS.md` |
| Skill Root | `~/.agents/skills` | `<scope>/.agents/skills` |
| Skill roots read | `~/.agents/skills` | `<scope>/.agents/skills` |

No harness reads `~/.agents/AGENTS.md`, so `generic` emits no global Instruction Layer. A profile whose harnesses have no global instruction file but which names a template produces an `instruction-layer-unsupported` warning.

### 5.2 Codex adapter

| Artifact | Global destination | Scoped destination |
|---|---|---|
| Instruction Layer | `$CODEX_HOME/AGENTS.md`, default `~/.codex/AGENTS.md` | `<scope>/AGENTS.md` |
| Personal Instruction Layer | none | `<scope>/AGENTS.override.md` |
| Skill Root | none | `<scope>/.codex/skills` |
| Skill roots read | `~/.agents/skills`, `$CODEX_HOME/skills` | `<dir>/.agents/skills`, `<dir>/.codex/skills` |

Codex marks `$CODEX_HOME/skills` deprecated, so global Codex skills come from `generic`. Codex reads `AGENTS.override.md` instead of `AGENTS.md` in the same directory; agentsmith writes it for the personal layer (section 5.5). An existing `AGENTS.override.md` that agentsmith did not record writing is a hard preflight error (`codex-override-shadow`) because it shadows the generated `AGENTS.md`; so is `$CODEX_HOME/AGENTS.override.md` beside the global layer. The adapter models global then repository-to-working-directory instruction order. It warns when a project instruction chain exceeds Codex's documented default 32 KiB cap and labels the cap as configurable.

### 5.3 Claude Code adapter

| Artifact | Global destination | Scoped destination |
|---|---|---|
| Instruction Layer | `~/.claude/CLAUDE.md` | `<scope>/CLAUDE.md` |
| Personal Instruction Layer | none | `<scope>/CLAUDE.local.md`, with `<scope>/CLAUDE.md` in `claudeMdExcludes` |
| Skill Root | `~/.claude/skills` | `<scope>/.claude/skills` |
| Skill roots read | `~/.claude/skills` | `<dir>/.claude/skills` |

The adapter models ancestor discovery and nested on-demand discovery. Generated Claude artifacts are flat and self-contained, with one exception: when a project scope's rendered `CLAUDE.md` is byte-identical to the `AGENTS.md` rendered at the same scope, `CLAUDE.md` contains only `@AGENTS.md`. Claude Code never loads an imported `AGENTS.md` twice, whatever its Project instructions setting. Omitting `CLAUDE.md` is not supported, because any `CLAUDE.md` above the working directory disables Claude Code's `AGENTS.md` fallback. Project configuration `claude_import_agents_md = false` disables the import.

### 5.4 Shared instruction files

Harnesses whose adapters resolve to the same instruction destination share one artifact. For `<scope>/AGENTS.md`, shared by `generic` and `codex`:

- the template is the first existing of `codex.md` (when `codex` is selected), `generic.md` (when `generic` is selected), and `default.md`;
- common instruction snippets render first, then `instructions/generic/` snippets when `generic` is selected, then `instructions/codex/` snippets when `codex` is selected;
- the `AGENTS.override.md` preflight and personal file apply when `codex` is selected.

In general, the selected harness with the highest adapter precedence supplies the template variant, and harness snippets render in ascending precedence.

### 5.5 Shared and personal project layers

A project input is **shared** when it lives in the project's own `.config/agentsmith/` tree and is not a `*.local.md` file. Every other input is **personal**: Source Repository templates, packs (their instruction and skill-slot snippets), skills, and partials, and project `*.local.md` snippets and partials.

Each project Instruction Layer renders twice:

- The **shared layer** renders from shared inputs only and is written to the adapter's Instruction Layer file (`<scope>/AGENTS.md`, `<scope>/CLAUDE.md` or its `@AGENTS.md` import). It is meant to be committed, and adding or changing a personal input never changes it. A personal include renders as nothing; a personal pack contributes nothing. When the template itself is personal, the shared file is not written (notice `shared-layer-unavailable`). When shared inputs alone fail to render, for example a required slot only a personal pack fills, the shared file is not written (warning `shared-layer-incomplete`).
- The **personal layer** renders from every input and is written only when it differs from the shared layer (or no shared file is written), to each sharing harness's personal file: `<scope>/AGENTS.override.md` for `codex` and `<scope>/CLAUDE.local.md` for `claude`. `generic` has no personal file: generic tools read the shared layer. With `claude_import_agents_md`, a `CLAUDE.local.md` byte-identical to the `AGENTS.override.md` planned beside it contains only `@AGENTS.override.md`.

When both `<scope>/CLAUDE.md` and `<scope>/CLAUDE.local.md` are written, the absolute path of `<scope>/CLAUDE.md` is added to `claudeMdExcludes` in `<project>/.claude/settings.local.json`, so Claude Code loads only `CLAUDE.local.md` for that directory and does not fall back to `AGENTS.md`. agentsmith never writes an exclude without the local file beside it: stale entries are removed before personal files are deleted, and new ones are added after personal files are written.

agentsmith owns only the entries it recorded in project state. Every other key of `settings.local.json`, and every other `claudeMdExcludes` entry, is preserved; an emptied `claudeMdExcludes` loses its key, and a file left as `{}` is removed. Invalid JSON, a non-object, or a non-string-list `claudeMdExcludes` is a configuration error before anything is written. A `settings.local.json` tracked by Git is a configuration error when entries are needed, since they hold this machine's paths.

Personal files are excluded from Git through the repository's `info/exclude` (`git rev-parse --git-path info/exclude`) as anchored lines (`/AGENTS.override.md`, `/app/CLAUDE.local.md`), so the repository never mentions a personal layer. `/.claude/settings.local.json` is added too while agentsmith keeps `claudeMdExcludes` entries and Git does not already ignore the file. `info/exclude` is shared by every worktree of a repository while project state is per worktree, so agentsmith only ever adds lines, never removes them (not in `project generate` and not in `project clean`): removing a line one worktree no longer needs could un-ignore another worktree's file. Added lines go into one block, created at the end of the file when missing:

```text
# BEGIN agentsmith: personal files, shared by every worktree. agentsmith adds lines here and never removes them.
/AGENTS.override.md
# END agentsmith
```

A line already present anywhere in the file is not added again, and every other line is kept. Project state records the lines the worktree needs.

Skills are not layered: shared and personal skills render once, with every input, into the same Skill Roots, which are meant to be ignored (`project init`, section 11.1).

### 5.6 Third-party repositories

A repository whose committed instruction files belong to someone else is configured with `upstream` in its project configuration, or, when it has none, by a profile `[[projects]]` entry. Project commands that find no `.config/agentsmith/config.toml` load the machine configuration's profile and use the first entry whose `path` equals the Git worktree root or whose `remote` matches one of the repository's remote URLs. Remotes compare as `host/path` with the scheme, user, trailing `/`, and `.git` removed and the host lowercased, so `git@github.com:acme/tool.git`, `ssh://git@github.com/acme/tool`, and `https://github.com/acme/tool` match `github.com/acme/tool`; local paths are canonicalized. A profile entry is a project with one repository scope at `.`, default `upstream = "keep"`.

Every input is personal; there is no shared layer, and agentsmith never writes a file Git tracks (configuration error). Personal files are always written:

- `keep`: `AGENTS.override.md` holds the upstream `AGENTS.md` (when present and not written by agentsmith), a blank line, and the personal layer, because Codex reads it instead of `AGENTS.md`. `CLAUDE.local.md` holds only the personal layer and no `claudeMdExcludes` entry is written, because Claude reads it beside the upstream `CLAUDE.md`. When the directory has no `CLAUDE.md` or `.claude/CLAUDE.md` but has an upstream `AGENTS.md`, `CLAUDE.local.md` starts with `@AGENTS.md` and a blank line, since its presence turns off Claude Code's `AGENTS.md` fallback.
- `replace`: both files hold only the personal layer, and `<scope>/CLAUDE.md` is added to `claudeMdExcludes`.

Upstream skills stay visible; a generated skill whose name matches one is an error (section 8.1). Generic tools read the upstream `AGENTS.md`. Because the repository's `.gitignore` is not agentsmith's to edit, each generated skill directory and, for a project configuration, `/.config/agentsmith/` are added to `info/exclude` unless Git tracks something inside them.

### 5.7 Physical destination collisions

If adapters plan the same physical destination outside a shared instruction artifact, agentsmith coalesces byte-identical content into one write. Different content for the same destination is a planning error.

## 6. Directives

Recognized directives must begin at column zero, occupy the complete line, and occur outside a CommonMark fenced code block.

```md
<!-- agentsmith:slot tools -->
<!-- agentsmith:required-slot verification -->
<!-- agentsmith:include grilling/core.md -->
<!-- agentsmith:include project:domain/terms.md -->
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

### 6.1.1 Reserved edge slots

Every Instruction Layer, global and project, has two implicit slots: `prepend` and `append`. Templates and partials may not declare them (`slot-reserved` error). Contributions to `prepend` are placed before the rendered template and contributions to `append` after it. Edge snippets expand includes but are otherwise inserted verbatim: each snippet ends with exactly one newline, snippets are concatenated in contribution order without trimming or separating blank lines, and the whole artifact is then normalized once (LF line endings, exactly one terminal newline). Skills have no reserved slots.

Instruction snippets for pack `github` and slot `tools` are discovered in this order:

1. `packs/github/instructions/tools/*.md`
2. `packs/github/instructions/<harness>/tools/*.md`

Reusable skill snippets for slot `tracker` are discovered in this order:

1. `packs/github/skill-slots/tracker/*.md`
2. `packs/github/skill-slots/harnesses/<harness>/tracker/*.md`

`<harness>` is any selected harness name, including `generic`. Section 7.1 restricts where harness-specific skill snippets may render.

Skill-slot contributions are keyed only by slot name, never by consuming skill name. The same snippet may therefore be rendered into multiple enabled skills. Skill sources and contributing packs may have different owners: for example, a project-owned `tracker` pack may fill `tracker` slots in shared skills.

A `skills/<skill>/<slot>/` directory inside a pack is invalid because it couples the provider to a consumer. Planning fails with a migration diagnostic directing the author to `skill-slots/<slot>/`.

Across packs, the Scope Pack Selection order is primary.

### 6.2 Includes

- Includes resolve only beneath an eligible owner's `partials/` directory.
- Unqualified project includes resolve project-first, then fall back to the Source Repository.
- `source:` and `project:` includes restrict lookup to one owner.
- Global includes resolve only from the Source Repository.
- Missing files, cycles, root escape, and symlinks are errors.
- Includes expand recursively before slot filling.

### 6.3 Heading rebasing

Only column-zero ATX headings are structural. Setext headings in partials are errors. Fenced-code headings are ignored.

A body-only partial inserts verbatim. A headed partial must begin with H1. At the include occurrence, its H1 becomes one level below the nearest preceding rendered ATX heading; all relative heading depths are preserved. Absence of a parent or a result deeper than H6 is an error.

Snippet headings are not rewritten. Lint warns when a snippet's first structural heading is at or above the heading surrounding its slot.

## 7. Skill planning and generation

For one scope and one selected harness, enabled skill Source IDs are the stable ordered union of:

1. skills enabled by selected packs, in pack order;
2. `skills_enable` entries;
3. minus `skills_disable` entries;
4. plus `harness_skills.<harness>.enable` entries;
5. minus `harness_skills.<harness>.disable` entries.

`harness_skills` is a table keyed by harness name, available on profiles and scopes (`[harness_skills.claude]`, `[scopes.harness_skills.claude]`). Each entry accepts only `enable` and `disable` Source ID lists. An unknown harness, a harness the profile or scope does not select, and a Source ID in both lists are configuration errors. A harness exclusion that matches nothing is a warning.

Selections resolving to the same canonical Source ID are idempotent. A qualified exclusion matches one owner; an unqualified exclusion matches either owner with the same logical name. Exclusion affects only skills introduced by that scope; it cannot hide inherited skills.

Every skill source is a directory containing `SKILL.md`. All Markdown files pass through include and slot rendering. Non-Markdown files copy unchanged, including executable mode. A common skill source is rendered once per placement root (section 7.1), with harness-specific pack snippets only where one harness alone reads that root.

The public Skill Name is parsed from `SKILL.md` YAML front matter. Only the Agent Skills metadata is parsed; snippets and partials do not use front matter. The `name` and `description` fields are required, and `name` must equal the source directory basename.

### 7.1 Placement

Each skill enabled at a scope for a set of harnesses is written to the fewest Skill Roots that let each of those harnesses read it exactly once. Candidates are the harnesses' own Skill Roots; a root read by more of the harnesses is chosen first, and a root is skipped when a harness it serves is already served. With the built-in adapters:

| Enabled for | Project scope | Global Scope |
|---|---|---|
| `generic`, with or without `codex` | `<scope>/.agents/skills` | `~/.agents/skills` |
| `codex` without `generic` | `<scope>/.codex/skills` | error `skill-harness-unplaceable` |
| `claude` | `<scope>/.claude/skills` | `~/.claude/skills` |

A harness with no Skill Root of its own that no chosen root serves produces `skill-harness-unplaceable`, naming the harnesses whose roots it reads.

Harness-specific skill snippets render only into a root read by exactly one harness, and only that harness's snippets. When a skill lands in a root read by several harnesses, a consumed snippet belonging to a selected harness that reads that root is an error (`skill-harness-content-shared-root`): Codex would read the common `.agents/skills` copy without its Codex content.

### 7.2 Collision policy

Visibility is evaluated per harness over every Skill Root that harness reads. Codex, for example, reads both `.agents/skills` and `.codex/skills`, so skills of the same name in each collide for Codex. Only selected harnesses are considered.

- A public Skill Name may be emitted at only one visible scope along any effective chain.
- Different Source IDs declaring the same public name are errors.
- A planned skill colliding with a visible unmanaged filesystem skill is an error.
- Two unmanaged visible skills colliding with each other produce a warning.
- Malformed or unreadable unmanaged `SKILL.md` produces a warning.
- Plugin, admin, bundled, and otherwise undiscoverable external skills are out of scope.
- When machine configuration is available, project checks include generated personal skills. Hermetic checks state that only project scopes were analyzed.

### 7.3 Exclusive mode

For each scope with exclusive mode on (the Global Scope with a profile's `exclusive`, or a project scope), every entry of every Skill Root read by a harness the scope selects, at that scope, is examined. Hidden entries (names starting with `.`) and non-directory entries other than symlinks are skipped. An entry is an unmanaged skill unless the plan writes a skill there, a recorded artifact (global state, or project state) lies inside it, or its name matches an `exclusive_allow` glob. Globs match the whole name; `*` matches any characters, `?` one character, `[set]` and `[!set]` one character; a glob containing `/` or `\` is a configuration error.

Unmanaged skills in exclusive scopes are excluded from the planned-versus-unmanaged collision error (section 7.2). Instead `lint`, `generate`, and `sync` fail with `artifact-modified` (exit 5), listing every path. With `--on-modified=backup` (`global sync`, `global generate`, `project generate`), each one is moved to `<backup root>/<UTC timestamp>/<original absolute path>` after preflight and before application, and restored if application fails. The global backup root is `<home>/.agents/agentsmith/backups`; the project backup root is `<Git directory>/agentsmith/backups`. Global moves are recorded as `unmanaged` backups and `unmanaged-skill-backup` warnings in `status.json`; project moves are printed as warnings. `--force` does not affect unmanaged skills.

`global adopt --skill NAME [--pack NAME] [--push | --no-commit] [--dry-run]` turns an unmanaged global skill into a managed one:

1. `NAME` is one directory name (`[A-Za-z0-9][A-Za-z0-9._-]*`). `--pack` follows the single-candidate rule of section 8.2.3. With `--push`, the Source Repository must be clean and is fast-forwarded first.
2. Candidates are the existing entries named `NAME` in the global Skill Roots read by the profile's harnesses that are not planned or recorded, whether or not exclusive mode is on. None is an error; candidates with more than one real path are an error.
3. `skills/NAME` must not exist in the Source Repository. The candidate's `SKILL.md` must parse with `name` equal to `NAME`, and the directory may not contain symlinks.
4. Files are copied with their modes to `skills/NAME/`, and `NAME` is appended to `packs/<pack>/pack.toml` `skills`, keeping the manifest's formatting where possible. The rebuilt plan must lint and generate the skill; otherwise both changes are reverted and the command exits 2.
5. Unless `--no-commit`, only those paths are committed (`Adopt skill NAME`), and pushed with `--push`, with the commit and push failure rules of section 8.2.3. A pack manifest with uncommitted changes is rejected unless `--no-commit`.
6. Every candidate is moved to the backup root, then the global generate path runs and records `status.json`. A regeneration failure keeps the adopted source and reports the underlying exit code.

`project adopt --skill NAME [--scope PATH] [--pack NAME] [--dry-run]` applies the same steps to the selected scope's Skill Roots, copies into `.config/agentsmith/skills/NAME/`, appends to a project-owned pack selected by the scope, never commits, leaves in place a candidate that Git reports tracked and clean (it is regenerated over), and runs the project generate path.

## 8. Planning, state, and writes

All mutating commands create a Generation Plan containing writes and stale deletions. The tool renders, validates, checks collisions, evaluates budgets, and preflights every destination before changing the filesystem.

### 8.1 Project safety

Project generation requires every destination to belong to the same Git worktree as the project configuration. Nested independent repositories in one plan are unsupported.

- Missing destinations are allowed. A tracked file deleted in the worktree but not in the index counts as missing.
- Existing tracked-clean destinations may be replaced.
- A recorded destination whose content still matches its recorded hash may be replaced whatever Git reports (ignored, untracked, modified, or staged), unless it is conflicted. This lets agentsmith regenerate ignored skills and untracked personal files, and generated changes not yet committed.
- Any other modified, staged, conflicted, untracked, or ignored destination fails the entire plan.
- A planned skill directory that already holds a file agentsmith did not record, and that the plan does not write with identical bytes, fails the plan with a configuration error naming the directory: it was committed by the repository's authors or written by hand. Rename the generated skill or adopt the directory.
- There is no force option.

agentsmith records the paths it generated, with the SHA-256 of each one's content, beneath the worktree's actual Git directory. Previously recorded paths absent from the next plan become stale deletions. A stale path is deleted only when Git reports it clean or missing, or when its content matches the recorded hash. Unrecorded paths are never deleted. State written by an older agentsmith has no hashes; its paths fall back to Git alone.

### 8.2 Global safety

Global state records destination paths and content hashes outside generated artifacts. The content of every generated global artifact is also stored as a blob named by its SHA-256 hash. Blobs are written before the state that references them; blobs no longer referenced by state are removed only after a successful application. A failed or interrupted run therefore never leaves state referring to missing content.

- A missing destination may be created.
- An existing unrecorded destination requires `--force` for initial adoption.
- A recorded destination may be replaced only when its current content matches recorded state.
- `--force` is limited to global generate/sync adoption or recovery.
- Stale recorded artifacts are deleted only when unchanged from recorded state.

`global sync` and `global generate` accept `--on-modified=fail|backup` (default `fail`). With `backup`, every modified, unrecorded, or modified stale artifact that would otherwise fail preflight is renamed to `<path>.agentsmith-<UTC timestamp>` (format `YYYYMMDDTHHMMSSZ`, with `-<n>` appended if that name exists) before application. A conflicting file inside a skill backs up the whole skill directory (the nearest ancestor whose `SKILL.md` is recorded or planned) to `~/.agents/agentsmith/backups/<UTC timestamp>/<original absolute path>`. Skill backups never stay in a skill root, because harnesses would discover them as additional skills with the same name. Backups are reported as warnings. If application fails, backups are moved back. File/directory transitions over unowned content still fail in both modes.

### 8.2.1 Run status

Every `global sync` and `global generate` writes `status.json` atomically after it finishes, successfully or not. It records `version` (1), `command`, `startedAt`, `timestamp` (finish time), `profile`, `sourceCommit` (Source Repository `HEAD` after any pull, or `null`), `outcome` (`success` or `failure`), `exitCode`, `error` (`{ code, message }` or `null`), `warnings` (plan warnings and backups, as printed), and `backups` (`{ path, backup, reason }`). Failure to write status is a warning and does not change the run's exit code.

### 8.2.2 Adoption

`global adopt` considers every existing global artifact whose content differs from recorded state, plus every planned instruction destination that exists unrecorded. It adopts only Instruction Layers (`AGENTS.md`, `CLAUDE.md`) whose content equals `prefix + stored + suffix`, where `stored` is the blob for the recorded hash and the first occurrence of `stored` determines the split. It refuses the whole operation, writing nothing, when any candidate is a skill file, a stale artifact, unrecorded, missing its blob, or edited anywhere else.

Adopted text is written to snippets in `<source>/packs/<pack>/instructions/<harness>/`: prefixes to `prepend/00-adopted.local.md` (new text before existing content) and suffixes to `append/99-adopted.local.md` (new text after existing content). With `--slot NAME`, prefix then suffix are appended to `<NAME>/99-adopted.local.md`. `--pack` must be selected by the active profile and is required unless the profile selects exactly one pack. Every snippet path must be ignored by Git in the Source Repository (`git check-ignore`). After writing the snippets, adopt rebuilds the plan, checks that the adopted text renders into each artifact, and generates with the adopted destinations accepted despite their modification. If any step fails, snippet files are restored. `--dry-run` reports without writing.

### 8.2.3 Adding snippets

`global add SLOT [TEXT]` and `project add SLOT [TEXT]` write one new snippet into a pack slot.

- Content is `TEXT`, `--file PATH`, or standard input when neither is given and standard input is not a TTY; more than one source, or none, is a usage error. Line endings are normalized to LF and a final newline is ensured; whitespace-only content is an error.
- The target directory is `<pack>/instructions/[<harness>/]<SLOT>/`, or with `--skill-slot` `<pack>/skill-slots/[harnesses/<harness>/]<SLOT>/`, where `<pack>` is `<source>/packs/<name>` for global add and `<project>/.config/agentsmith/packs/<name>` for project add. `SLOT` is one logical path segment; a common slot named after a harness (instructions) or `harnesses` (skill slots) is rejected because that directory holds harness-specific snippets.
- Validation uses the plan's slot targets: every Instruction Layer and skill placement of the selected scope with the slots it declares (template slots after includes, plus the reserved edge slots for Instruction Layers; slots declared in a skill's Markdown files). `--harness` must be selected by the scope. An instruction slot must be declared by every Instruction Layer the snippet reaches: all layers of the scope without `--harness`, or the layer shared by that harness with it. A skill slot must be declared by at least one receiving placement: all skill placements of the scope without `--harness`, or placements whose root is read exclusively by that harness with it. Failures exit 2 and list the declared slots; skill-slot output lists the receiving skills. A plan that already fails lint is rejected before writing.
- `--pack` is required unless exactly one candidate exists: the active profile's packs (global), or the project-owned packs selected by the scope (project). The same rule applies to `global adopt`. Project add selects the scope with `--scope PATH` (a configured scope path), defaulting to the deepest scope containing the current directory, else `.`.
- The file name is `NN-<slug>.md`, or `NN-<slug>.local.md` with `--local`. Only directory entries named `NN-…` with exactly two leading digits contribute prefixes; other entries are ignored. `gap` (default) chooses `lower + 1` for the pair of consecutive prefixes, or the highest prefix and 100, with the most free numbers between them, ties to the lowest pair. `first` chooses `lowest - 1`; `last` chooses `highest + 1`. An empty directory starts at 50 for every placement. No free number is an error; existing files are never renamed. The slug is derived from `--name` (a trailing `.md` or `.local.md` is dropped) or from the first content line with a letter or digit: NFKD-folded, lowercased, non-alphanumeric runs replaced by `-`, at most six words and 48 characters; content without such a line yields `snippet`.
- `--local` is global only and requires `git check-ignore` to report the path ignored.
- After writing, the plan is rebuilt and must lint without errors and list the new file in some artifact's provenance; otherwise the file and any directories created for it are removed and the command exits 2. Regeneration then runs the global generate path (recording `status.json`) or the project generate path, unless `--skip-generate`. A regeneration failure keeps the snippet and reports the underlying error and exit code.
- A global snippet that is not `--local` is committed by default: only the new path, with no pull and no clean-source requirement. The commit is not pushed, and the output says so. `--no-commit` (global only, incompatible with `--push`) skips the commit.
- `--push` is global only and incompatible with `--local` and `--no-commit`. It runs `git pull --ff-only` after the clean-source check, chooses the number on the pulled tree, writes and lints, commits only the new path, runs `git push`, then regenerates. A failed commit removes the file. A failed push exits 1, keeps the commit, and skips regeneration.
- `--dry-run` validates and prints the path, number, and content without writing, pulling, or regenerating.

### 8.2.4 Clean

`global clean [--config PATH]` and `project clean [--project PATH] [--scope PATH]` accept `-y`/`--yes`, `--force`, and `--on-modified=fail|backup`. Without `--yes` they validate and print every path that would be removed, and write nothing.

- Global candidates are the recorded artifacts in global state that exist. One is unchanged when it is a regular file whose SHA-256 equals the recorded hash. Project candidates are the recorded project paths that exist, limited with `--scope` to paths whose deepest containing declared scope is that scope. One is unchanged when it is a regular file whose SHA-256 equals the recorded hash, or whose bytes equal the current project plan's write for that path, or when Git reports it `tracked-clean`; if the project plan cannot be built, only Git is consulted (with a warning).
- Any changed candidate fails the command with `artifact-modified` (exit 5) before anything is removed, in dry runs too, unless `--on-modified=backup` or `--force`. With `backup`, changed global artifacts are backed up as in section 8.2 (an instruction file beside itself, a skill file's whole skill directory under the backup root) and changed project artifacts are moved to `<Git directory>/agentsmith/backups/<UTC timestamp>/<original absolute path>`; then they are removed. With `--force` they are removed without a backup.
- Project clean also removes the `claudeMdExcludes` entries recorded for the removed paths, before the files. It keeps every `info/exclude` line (section 5.5) and says so.
- Then the mode's state is removed: global `state.toml`, `status.json`, and `blobs/`; project state, unless `--scope` leaves other recorded paths, in which case state is rewritten without the removed paths.
- Each now-empty parent directory of a removed path is removed, up to but excluding the home (global; the sandbox home when set), the worktree root (project artifacts), or the Git directory (project state).
- The machine configuration, Source Repository, backups, logs, and the installed schedule are not touched. Removed tracked project files remain Git worktree deletions.

### 8.3 Application

Writes use same-filesystem temporary paths and atomic rename. Before application, previous content is backed up. If any application step fails, agentsmith restores the prior artifact set and state file.

## 9. Git synchronization

`global sync` requires the Source Repository to be a Git worktree with an upstream. It rejects tracked, staged, conflicted, and nonignored untracked changes. Ignored local source is permitted. It runs:

```sh
git pull --ff-only
```

The command is noninteractive and propagates missing-upstream, detached-head, authentication, conflict, and non-fast-forward failures without generating.

Other global commands perform no Git synchronization, except `global init`, which clones. Project commands never synchronize.

## 9a. Machine bootstrap and scheduling

`global init <git-url> --profile NAME [--source PATH] [--config PATH] [--schedule [--interval DURATION]] [--yes]` runs, in order, stopping at the first failure:

1. Validate options. `--interval` requires `--schedule`; with `--schedule` the interval is validated and an unsupported platform fails before anything is written.
2. If a machine configuration exists at the config path and selects a different source path or profile (or cannot be read), fail with exit 2 and print the command to rerun with `--yes`. `--yes` replaces it.
3. Clone the Source Repository noninteractively (`GIT_TERMINAL_PROMPT=0`) to `--source`, default `~/.agents/agentsmith/source`. A missing or empty directory is cloned into (clone failure: exit 4). A nonempty directory is reused only when it is the root of a Git worktree and one of its remotes matches the URL after normalization (local paths canonicalized; trailing `/` and `.git` ignored); otherwise exit 2.
4. Resolve the profile, including its `extends` chain. A missing or unresolvable profile fails with exit 2 and lists every `profiles/**/*.toml` name.
5. Write the machine configuration (`source` as an absolute path, `profile`), unless it already matches.
6. Lint the global plan (errors exit 2) and print every planned write as `create`, `update`, `unchanged`, `replace unrecorded`, or `replace modified`, plus stale removals.
7. If any planned destination is an unrecorded or modified global artifact, print its diff. With `--yes`, continue with `--on-modified=backup`. In an interactive terminal, ask; a refusal exits 5. Without a terminal and without `--yes`, exit 5 and print the command to rerun with `--yes`.
8. Run `global sync` with the chosen `--on-modified` mode, recording `status.json` like any sync.
9. With `--schedule`, run `global schedule install` with `--interval` and `--config`.

`global schedule install [--interval DURATION] [--config PATH]` requires a readable machine configuration. The interval uses the `global status --max-age` duration syntax, defaults to `1h`, and must be at least `1m`. The job runs:

```text
<asmith invocation> global sync --on-modified=backup [--config <absolute PATH>]
```

The invocation is the running executable: the compiled binary alone, or the runtime (`process.execPath`) plus the canonical script path for the npm build or a source checkout. Scheduling a TypeScript source checkout prints a warning. The job's `PATH` is the executable's directory, the installing shell's `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, without duplicates. `CODEX_HOME` is carried over when set.

- macOS: `~/Library/LaunchAgents/io.github.niieani.agentsmith.sync.plist` with `StartInterval`, `RunAtLoad`, and the job run through `/bin/sh -c "exec … >~/.agents/agentsmith/logs/last-run.log 2>&1"`, so each run overwrites one combined log rather than launchd appending forever. Install boots out a loaded job, then runs `launchctl bootstrap gui/<uid> <plist>`. Uninstall boots it out and removes the plist.
- Linux: `agentsmith-sync.service` (oneshot) and `agentsmith-sync.timer` (`OnBootSec=2min`, `OnUnitActiveSec=<seconds>s`, `Persistent=true`) in `$XDG_CONFIG_HOME/systemd/user` (default `~/.config/systemd/user`), then `systemctl --user daemon-reload` and `enable --now agentsmith-sync.timer`. When `loginctl` does not report lingering, install prints `loginctl enable-linger <user>`. Uninstall disables the timer, removes both units, and reloads.
- Other platforms fail with exit 1.

After installing, the command runs `git ls-remote` in the Source Repository with the job's `PATH`, without `SSH_AUTH_SOCK`, askpass programs, or terminal prompts, and with `ssh -o BatchMode=yes` unless `GIT_SSH_COMMAND` or `core.sshCommand` is set. Failure prints a warning recommending a read-only deploy key or a stored HTTPS token; it never fails the install.

With a sandbox `home`, the log directory is `<home>/.agents/agentsmith/logs`; the job definition stays in the real home. `global init` keeps an existing configuration's `home` value when it rewrites the file and, without `--source`, clones to `<home>/.agents/agentsmith/source`.

`global schedule status` reports whether the job is installed and loaded or active, its definition file, interval, and command, and the last run from `status.json`, found through the installed job's `--config` when present. It exits 0.

## 10. Budgets

Supported optional positive UTF-8 byte warning thresholds:

- `instruction_layer_bytes`
- `effective_instruction_bytes`
- `skill_markdown_bytes`

Effective instruction size is evaluated for every declared scope chain and harness. Skill Markdown size includes rendered Markdown files but excludes copied support files; explain reports support-file bytes separately.

Budgets warn and never truncate. `lint --warnings-as-errors` turns warnings into failure for CI. Source Repository budgets cascade to global profiles; project budgets stand alone.

## 11. CLI

```text
asmith global sync [--config PATH] [--force] [--on-modified fail|backup]
asmith global generate [--config PATH] [--force] [--on-modified fail|backup]
asmith global diff [--config PATH]
asmith global clean [--config PATH] [-y|--yes] [--force] [--on-modified fail|backup]
asmith global lint [--config PATH] [--warnings-as-errors]
asmith global explain [--config PATH] [--json]
asmith global status [--config PATH] [--json] [--max-age DURATION]
asmith global adopt [--config PATH] [--slot NAME] [--pack NAME] [--dry-run]
asmith global adopt --skill NAME [--config PATH] [--pack NAME] [--push | --no-commit] [--dry-run]
asmith global add SLOT [TEXT] [--file PATH] [--skill-slot] [--harness NAME] [--pack NAME] [--placement gap|first|last] [--name NAME] [--local] [--push | --no-commit] [--skip-generate] [--dry-run] [--config PATH]
asmith global init GIT_URL --profile NAME [--source PATH] [--config PATH] [--schedule] [--interval DURATION] [--yes]
asmith global schedule install [--interval DURATION] [--config PATH]
asmith global schedule uninstall
asmith global schedule status

asmith project init [--project PATH] [--template NAME] [--prepare]
asmith project generate [--project PATH] [--on-modified fail|backup]
asmith project adopt --skill NAME [--project PATH] [--scope PATH] [--pack NAME] [--dry-run]
asmith project diff [--project PATH]
asmith project clean [--project PATH] [--scope PATH] [-y|--yes] [--force] [--on-modified fail|backup]
asmith project lint [--project PATH] [--warnings-as-errors]
asmith project explain [--project PATH] [--json]
asmith project add SLOT [TEXT] [--project PATH] [--scope PATH] [--file PATH] [--skill-slot] [--harness NAME] [--pack NAME] [--placement gap|first|last] [--name NAME] [--skip-generate] [--dry-run]
```

`project` walks from the requested path, or current directory, toward its ancestors to find `.config/agentsmith/config.toml`. When none exists, `generate`, `diff`, `lint`, `explain`, and `clean` fall back to a matching profile `[[projects]]` entry (section 5.6).

Exit status:

| Code | Error code | Cause |
|---|---|---|
| 0 | | Success, including warnings and backups |
| 1 | `failure` | Any other failure, including project preflight and application errors |
| 2 | `config` | Configuration, usage, planning validation, or `lint --warnings-as-errors` |
| 3 | `source-dirty` | Source Repository has disallowed changes |
| 4 | `source-pull` | `git pull --ff-only` or the `global init` clone failed |
| 5 | `artifact-modified` | Modified or unrecorded global artifact, unowned global content in a transition, an exclusive-mode unmanaged skill, a modified artifact during `clean`, refused adoption, or `global init` not confirmed |
| 6 | `status-stale` | `global status`: no recorded run, or older than `--max-age` |

Warnings alone succeed unless `--warnings-as-errors` is active. Notices report inputs deliberately left out and never fail a run, even with `--warnings-as-errors`. `global status` exits with the recorded exit code when the last run failed, otherwise 6 when stale, otherwise 0. `--max-age` takes one or more `<number><unit>` terms with units `s`, `m`, `h`, `d`, `w`.

### 11.1 Project initialization

`project init [--project PATH] [--template NAME] [--prepare]` works on the Git worktree root containing `--project` or the current directory (not a Git repository: configuration error). It runs, stopping at the first failure:

1. If `.config/agentsmith/config.toml` is absent, write one selecting the harnesses whose directory exists at the root (`.agents/` → `generic`, `.codex/` → `codex`, `.claude/` → `claude`), or every harness when none does, with one repository scope `.` that has no template (with `--template NAME`: `template = "project:NAME"`) and no packs. An existing configuration is kept and its harnesses are used. With `--template`, the copy of step 2 is planned and checked before this step, so its errors leave the repository unchanged.
2. With `--template NAME` (a machine configuration is required; `NAME` must be a Source ID that is not `project:`-qualified): the template family is resolved as `source:NAME` (missing: configuration error). Every regular file directly in its directory is copied to `.config/agentsmith/templates/NAME/`; a symlink is a configuration error. Include directives outside code fences in copied files are followed transitively: a `project:` include is not followed; any other include resolves as in generation (unqualified: project first) and, when it resolves into the Source Repository, that partial is copied to `.config/agentsmith/partials/<name>`. In copied files every `source:<name>` include is rewritten to `project:<name>`. Each destination is checked first: an existing file with identical content is skipped, and any other existing path is a configuration error listing every such path. An existing configuration in which some scope names `NAME` or `project:NAME` is left alone. Otherwise scope `.` gets `template = "project:NAME"` (replacing the starter comment, or after its `path` line) when it has no template; when it has one, the configuration is unchanged and init prints the line to add by hand. Without `--template`, when a machine configuration names a Source Repository with template families and scope `.` does not use a project template, a hint names `asmith project init --template <name>` and the available families.
3. Append to `.gitignore`, under one comment line, every missing line of: `/<dir>/*` and `!/<dir>/.gitkeep` for each selected harness's project skill directory (`.agents/skills`, `.codex/skills`, `.claude/skills`), then `/.config/agentsmith/**/*.local.md`. Create each `<dir>/.gitkeep`. Claude Code reloads only skill directories that existed when a session started; the placeholder keeps the directory. Skill directories Git already tracks under a skill root are reported with `committed-skill` warnings.
4. With `--prepare`: `package.json` must exist (configuration error). The package manager is the `packageManager` field's name when it is `bun`, `pnpm`, `yarn`, or `npm`; otherwise the first lockfile present of `bun.lock`, `bun.lockb` (bun), `pnpm-lock.yaml` (pnpm), `yarn.lock` (yarn), `package-lock.json` (npm); otherwise npm. Unless `asmith` is in `devDependencies` or `dependencies`, run `bun add -d asmith`, `pnpm add -D asmith`, `yarn add -D asmith`, or `npm install -D asmith` in the root (failure: exit 1). Then, when `scripts.prepare` is absent, set it to `asmith project generate`, keeping the file's indentation and final newline. A `prepare` containing `asmith project generate` is left unchanged; any other is left unchanged with a `prepare-script-kept` warning printing `<existing> && asmith project generate`. Commands printed afterwards use `bunx asmith`, `pnpm exec asmith`, `yarn asmith`, or `npx asmith`.

The command is idempotent. agentsmith installs no session hooks: they would run on every start, resume, compaction, and subagent, and no harness loads instruction files or skills a hook creates during the same turn.

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

Codex behavior was verified against the Codex CLI source; the [harness discovery reference](../website/docs/reference/harness-discovery.md) records the details and unverified points.
