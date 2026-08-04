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
└── instructions/
    ├── tools/
    │   └── 10-bun.md
    └── codex/
        └── verification/
            └── 20-codex.md
```

Common snippets apply to every harness. Harness-specific snippets are appended after common snippets for that pack. Pack selection order comes first; paths within each pack sort lexically, so numeric filename prefixes make the intended order visible.

The directory itself defines an instruction-only pack. Add `pack.toml` only when the pack should enable skills:

```toml
skills = ["bun-debug"]
```

The manifest accepts only the optional `skills` field.

Skills use a parallel but consumer-agnostic layout:

```text
packs/github/
└── skill-slots/
    └── tracker/
        └── 10-github.md
```

Every enabled skill declaring `tracker` receives that snippet. The pack does not name the skills that consume it. See [Create a composable skill](/use-cases/skill-author) for the complete workflow.

## Source IDs

Unqualified IDs are the normal form:

```toml
template = "software"
packs = ["base", "bun"]
```

During project generation, templates, skills, and partials resolve from the project first, then the shared Source Repository. Matching packs merge additively, shared first and project second. Use a qualifier only to require one owner:

```toml
template = "source:software"
packs = ["base", "project:deploy"]
```

Missing sources are errors. `asmith project explain` shows each selected pack's canonical owner, path, and composition order.

## Additive only

Packs do not depend on, conflict with, or suppress other packs in v1. Select logical pack names in the desired order; matching shared and project packs compose automatically. This keeps configuration explainable and makes repeated generation deterministic.
