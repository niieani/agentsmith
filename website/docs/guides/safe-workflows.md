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

Global outputs are tracked by content hash in `~/.agents/agentsmith/state.toml`. A copy of each generated artifact is kept under `~/.agents/agentsmith/blobs/`, named by its hash. A recorded artifact is replaced or removed only when its current bytes still match recorded state.

`--force` allows initial adoption or recovery of global outputs. It does not bypass project Git safety.

## Unattended global sync

For a machine that syncs itself on a timer, run:

```sh
asmith global sync --on-modified=backup
```

When someone has edited a generated global file by hand, this moves the file aside as `<name>.agentsmith-<UTC timestamp>` and keeps converging instead of stopping. For a skill, the whole skill directory moves to `~/.agents/agentsmith/backups/<UTC timestamp>/<original path>`, outside every skill folder, so no harness loads it as a second copy. Each backup is a warning on stderr and in `~/.agents/agentsmith/status.json`. Review backups later and either move the change into the Source Repository or delete the backup.

Each run records its result in `status.json`. Monitor it with:

```sh
asmith global status --max-age 2h
```

This exits nonzero when the last run failed or is older than two hours. Each failure category has its own exit code, so a wrapper can tell a dirty Source Repository (3) from a pull that cannot fast-forward (4) or a modified artifact (5). See [Exit behavior](/reference/commands#exit-behavior).

## Trying a profile in a sandbox

To see what a profile or a Source Repository change does without touching your real `~/.claude`, `~/.codex`, or `~/.agents`, point a second machine config at a sandbox home:

```toml title="~/sandbox/config.toml"
source = "~/.agents/agentsmith/source"
profile = "experimental"
home = "home"
```

```sh
mkdir -p ~/sandbox/home
asmith global generate --config ~/sandbox/config.toml
ls ~/sandbox/home/.claude ~/sandbox/home/.agents/skills
asmith global status --config ~/sandbox/config.toml
```

Everything agentsmith writes, including its state, status, backups, and logs, lands under `~/sandbox/home`. Git keeps your real home, so `global sync` and `global add --push` use your usual identity and keys. Pass `--config` to every command that should act on the sandbox; without it, commands act on your real home. See [sandbox home](/reference/configuration#sandbox-home).

## Removing agentsmith's output

To stop using agentsmith on a machine or in a project, preview and then remove what it generated:

```sh
asmith global clean
asmith global schedule uninstall
asmith global clean --yes
```

`clean` removes only files agentsmith recorded and still recognizes, plus its own state. A file you edited stops the command; keep a backup with `--on-modified=backup` or discard the edit with `--force`. Your machine config, the Source Repository, and earlier backups stay, so `asmith global generate` brings everything back. In a project, `asmith project clean --yes` leaves the removed files as Git deletions for you to commit. See [cleaning up](/reference/commands#cleaning-up).

## Keeping local additions

If you add machine-specific text at the top or bottom of a generated global `AGENTS.md` or `CLAUDE.md`, keep it with:

```sh
asmith global adopt --dry-run
asmith global adopt
```

This writes your additions as Git-ignored `*.local.md` snippets in the reserved `prepend` and `append` slots, then regenerates. Pass `--pack NAME` when the profile selects more than one pack. Later generations keep reproducing the same file. Edits in the middle of generated content, and edits to skills, are never adopted: back them up and move them into the Source Repository by hand.

## Transactional writes

agentsmith builds and validates the complete plan before changing the filesystem. Writes use temporary paths and atomic renames. If application fails partway through, agentsmith restores the previous artifacts and state.

## CI

Use lint with warnings promoted to errors:

```sh
asmith project lint --warnings-as-errors
```

Budgets are warnings by default, so this flag turns size regressions and other warnings into a CI failure.
