---
title: Your first project
description: Generate AGENTS.md and CLAUDE.md for a Git repository.
---

Project generation combines reusable sources with configuration committed to a project. It never synchronizes or pulls Git.

## 1. Create a project config

At the repository root, create `.config/agentsmith/config.toml`:

```toml
harnesses = ["codex", "claude-code"]

[[scopes]]
path = "."
template = "software"
packs = ["base", "bun", "github"]
```

Every project must declare the repository scope with `path = "."`. The named template and packs come from your configured Source Repository.

## 2. Preview the plan

```sh
asmith project lint
asmith project explain
asmith project diff
```

- `lint` validates configuration, composition, collisions, and budgets.
- `explain` shows why each artifact exists and where its content came from.
- `diff` renders without writing and shows prospective changes.

## 3. Generate

```sh
asmith project generate
git add AGENTS.md CLAUDE.md .config/agentsmith
git commit -m "chore: generate agent context"
```

agentsmith only overwrites project outputs that Git reports as tracked and clean. Review and commit newly created outputs before regenerating them.

:::warning
Project-only sources work without machine configuration. A machine config is needed only when an unqualified name must fall back to the Source Repository or a `source:` reference is selected. When a machine config exists, project planning loads it so matching Source Repository packs cannot be omitted silently; that config must therefore be valid.
:::
