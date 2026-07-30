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
version = 1
harnesses = ["codex", "claude-code"]

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

## Skills and visibility

Skills are discovered from global, repository, and nested skill roots. agentsmith prevents a visible skill name from being generated twice along an effective scope chain. A nested scope may add new skills, but it cannot silently replace an inherited skill with the same public name.
