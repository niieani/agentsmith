---
title: Safe workflows
description: Preview changes, protect edits, and use agentsmith confidently in automation.
---

The safest workflow is always lint, explain, diff, then generate.

```sh
asmith project lint
asmith project explain
asmith project diff
asmith project generate
```

## Project safety

Project outputs must belong to one Git worktree. Existing destinations are replaced only when Git reports them as tracked and clean. Modified, staged, conflicted, untracked, or ignored destinations stop the whole plan.

Missing outputs may be created. After generation, review and commit them so later runs can safely replace them.

Previously generated paths are recorded beneath the worktree's actual Git directory. When configuration stops producing one of those paths, agentsmith deletes it only if Git still reports it clean.

## Global safety

Global outputs are tracked by content hash in `~/.agents/agentsmith/state.toml`. A recorded artifact is replaced or removed only when its current bytes still match recorded state.

`--force` allows initial adoption or recovery of global outputs. It does not bypass project Git safety.

## Transactional writes

agentsmith builds and validates the complete plan before changing the filesystem. Writes use temporary paths and atomic renames. If application fails partway through, agentsmith restores the previous artifacts and state.

## CI

Use lint with warnings promoted to errors:

```sh
asmith project lint --warnings-as-errors
```

Budgets are warnings by default, so this flag turns size regressions and other warnings into a CI failure.
