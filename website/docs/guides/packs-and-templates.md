---
title: Packs and templates
description: Compose ordered, reusable instruction sets without flattening your source organization.
---

Templates control document structure. Packs contribute reusable content to named slots and may enable skills. Profiles and scopes select an ordered list of packs.

## Template families

A template family can specialize by harness:

```text
templates/software/
├── default.md
├── codex.md
└── claude-code.md
```

For each harness, agentsmith chooses `<harness>.md` when present and otherwise uses `default.md`.

```md
# Working agreement

## Tools

<!-- agentsmith:slot tools -->

## Verification

<!-- agentsmith:required-slot verification -->
```

## Pack contributions

Pack snippets are grouped by the slot they fill:

```text
packs/bun/
├── pack.toml
└── instructions/
    ├── tools/
    │   └── 10-bun.md
    └── codex/
        └── verification/
            └── 20-codex.md
```

Common snippets apply to every harness. Harness-specific snippets are appended after common snippets for that pack. Pack selection order comes first; paths within each pack sort lexically, so numeric filename prefixes make the intended order visible.

Skills use a parallel but consumer-agnostic layout:

```text
packs/github/
└── skill-slots/
    └── tracker/
        └── 10-github.md
```

Every enabled skill declaring `tracker` receives that snippet. The pack does not name the skills that consume it. See [Create a composable skill](/use-cases/skill-author) for the complete workflow.

## Source IDs

Unqualified IDs resolve from the shared Source Repository:

```toml
template = "software"
packs = ["base", "bun"]
```

Project-owned sources use the explicit `@project/` namespace:

```toml
template = "@project/custom"
packs = ["base", "@project/deploy"]
```

There is no fallback or shadowing between shared and project-owned sources.

## Additive only

Packs do not depend on, conflict with, or suppress other packs in v1. Select them explicitly in the desired order. This keeps configuration explainable and makes repeated generation deterministic.
