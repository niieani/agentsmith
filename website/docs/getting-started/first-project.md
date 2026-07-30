---
title: Your first project
description: Generate AGENTS.md and CLAUDE.md for a Git repository.
---

Project generation combines reusable sources with configuration committed to a project. It never synchronizes or pulls Git.

## 1. Create a project config

At the repository root, create `.config/agentsmith/config.toml`:

```toml
version = 1
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
Project generation needs a machine config because global Source IDs such as `software` and `base` resolve from the configured Source Repository. Use `@project/...` IDs for sources that live only in this repository.
:::
