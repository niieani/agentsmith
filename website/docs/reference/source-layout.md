---
title: Source Repository layout
description: Organize profiles, templates, packs, skills, and partials.
---

The Source Repository is the Git-backed source of truth shared across machines and projects.

```text
agentsmith.toml
profiles/
  laptop.toml
templates/
  software/
    default.md
    codex.md
    claude-code.md
packs/
  github/
    pack.toml
    instructions/
      tools/
        10-common.md
      codex/
        tools/
          20-codex.md
    skill-slots/
      tracker/
        10-github.md
skills/
  to-issues/
    SKILL.md
partials/
  grilling/
    core.md
```

## Root config

`agentsmith.toml` is strict and always starts with `version = 1`. It may set warning budgets:

```toml
version = 1

[budgets]
instruction_layer_bytes = 24576
effective_instruction_bytes = 32768
skill_markdown_bytes = 16384
```

## Local machine-only source

All Markdown files are scanned, including Git-ignored `*.local.md`. This makes it possible to add machine-only snippets while keeping the main Source Repository clean for synchronization. Symlinks are rejected.

## Project-owned source

A project can mirror `templates/`, `packs/`, `skills/`, and `partials/` beneath `.config/agentsmith/`. Reference these with `@project/...` Source IDs. There are no project profiles because project behavior is declared directly in `.config/agentsmith/config.toml`.

## Ordering

Selected pack order is primary. Files within a pack use deterministic Unicode lexical path order. Numeric filename prefixes such as `10-`, `20-`, and `90-` make the rendered order obvious in the source tree.

## Reusable skill-slot contributions

A pack supplies skill content by slot name rather than consumer name:

```text
packs/github/skill-slots/
├── tracker/
│   └── 10-github.md
└── harnesses/
    └── claude-code/
        └── tracker/
            └── 20-claude.md
```

Every enabled skill declaring `slot tracker` or `required-slot tracker` receives these snippets. The pack does not list those consuming skills in its directory structure. Common snippets render first, followed by the active harness's snippets.

Do not put contributions under `packs/<pack>/skills/<skill>/...`. That consumer-coupled layout is rejected; use `skill-slots/<slot>/...` instead.
