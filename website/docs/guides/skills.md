---
title: Skills
description: Enable, compose, and generate native agent skills at the right scope.
---

agentsmith treats a skill as a source directory containing `SKILL.md` and optional support files. It generates that directory into each harness's native skill root.

## Enablement

For a scope, enabled skills are the ordered union of:

1. skills enabled by selected packs, in pack order;
2. `skills_enable` entries on the profile or scope;
3. minus `skills_disable` entries at that same scope.

A pack that enables skills declares them in its optional `pack.toml`:

```toml
skills = ["to-issues", "address-review"]
```

Instruction-only packs and packs that only contribute skill slots need no manifest.

A scope can adjust the result:

```toml
skills_enable = ["release-notes"]
skills_disable = ["address-review"]
```

An exclusion only affects skills introduced by that scope. It cannot hide a skill inherited from an ancestor.

## Skill sources

```text
skills/to-issues/
├── SKILL.md
├── references/
│   └── conventions.md
└── scripts/
    └── create.ts
```

`SKILL.md` needs Agent Skills front matter with `name` and `description`. The public `name` must match the source directory basename.

Every Markdown file is rendered through the same include-and-slot pipeline. This means directives inside Markdown support files are rendered too. It does **not** make include paths relative to the support file.

All includes use the same source-root lookup as directives in `SKILL.md`:

```md
<!-- agentsmith:include skills/severity-guidance.md -->
```

During project generation, an unqualified include first checks:

```text
<project>/.config/agentsmith/partials/skills/severity-guidance.md
```

then falls back to:

```text
<shared-source-repository>/partials/skills/severity-guidance.md
```

A qualifier can require the project-owned include:

```md
<!-- agentsmith:include project:skills/severity-guidance.md -->
```

It resolves to:

```text
<project>/.config/agentsmith/partials/skills/severity-guidance.md
```

Moving a Markdown support file within its skill directory therefore does not change how its includes resolve. Non-Markdown support files are copied byte-for-byte and retain executable mode.

## Composable skills

A skill can declare slots, and selected packs can provide reusable content for those slots:

```text
packs/github/skill-slots/tracker/10-github.md
packs/github/skill-slots/harnesses/claude-code/tracker/20-claude.md
```

Contributions are keyed by slot name, not skill name. The same `tracker` snippet is inserted into every enabled skill that declares a `tracker` slot. A project-owned pack can therefore supply one project's tracker instructions to any number of shared skills without knowing their names.

This produces flat, self-contained skills tailored to the selected packs and harness—no runtime skill chaining is required.

## Collision protection

agentsmith fails when two visible sources would emit the same public skill name or when a planned skill collides with an unmanaged visible skill. Use `asmith project explain` to see where a skill was enabled and `lint` to detect collisions before writing.

For a complete source-to-output example, continue with [Create a composable skill](/use-cases/skill-author).
