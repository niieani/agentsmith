---
title: Projects and scopes
description: Model inherited agent context in repositories and monorepo subtrees.
---

A **scope** is a project directory where agentsmith may emit a native instruction layer, a native skill root, or both. The repository root is always a scope. Nested scopes model monorepo areas that need additional context.

## Inheritance

Agent harnesses discover instructions along the directory path. agentsmith mirrors that behavior:

```text
repository scope (.)
└── apps
    └── ios scope (apps/ios)
```

Work under `apps/ios` sees both the repository layer and the iOS layer. A scope's `packs` are additive deltas; do not repeat packs already selected by an ancestor.

```toml
harnesses = ["generic", "codex", "claude"]

[[scopes]]
path = "."
template = "software"
packs = ["base", "github"]

[[scopes]]
path = "apps/ios"
template = "ios"
packs = ["swift", "ios"]
harnesses = ["codex"]
skills_enable = ["simulator-debug"]
```

## Scope rules

- Paths are existing project-relative directories and may not escape the project.
- The root scope `.` is required.
- Scope paths must be unique after normalization.
- A scope harness override must be a nonempty subset of the project harness list.
- Omitting `template` creates no instruction file at that scope.
- A skill root is created only when that scope introduces at least one skill.

## What each harness gets

At each scope with a template, the selected harnesses produce:

| Harness | Instruction file | Skill root |
| --- | --- | --- |
| `generic` | `AGENTS.md` | `.agents/skills` |
| `codex` | `AGENTS.md` | `.agents/skills` via `generic`, or `.codex/skills` for skills not enabled for `generic` |
| `claude` | `CLAUDE.md` | `.claude/skills` |

`generic` and `codex` share one `AGENTS.md`. Codex reads both `.agents/skills` and `.codex/skills`, so each skill is written to one root only: a skill enabled for `generic` lands in `.agents/skills` and serves Codex too, and only a Codex-only skill goes to `.codex/skills`. Use `[scopes.harness_skills.<harness>]` to enable or disable a skill for one harness.

When `CLAUDE.md` would be identical to the `AGENTS.md` beside it, agentsmith writes it as a one-line `@AGENTS.md` import, so Claude Code reads the same content without a second copy. Set `claude_import_agents_md = false` to write the full text. See [harness destinations](/reference/configuration#harness-destinations) and [harness discovery](/reference/harness-discovery).

## Skills and visibility

Skills are discovered from global, repository, and nested skill roots. agentsmith prevents a visible skill name from being generated twice along an effective scope chain. A nested scope may add new skills, but it cannot silently replace an inherited skill with the same public name.
