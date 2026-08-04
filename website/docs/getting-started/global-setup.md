---
title: Global setup
description: Synchronize global instructions and skills across machines with a Git-backed profile.
---

Global mode is for personal agent context that follows you across machines. Each host keeps a tiny machine config and selects one profile from a shared Source Repository.

## 1. Create the machine config

Create `~/.agents/agentsmith/config.toml`:

```toml
source = "~/.agents/agentsmith/source"
profile = "laptop"
```

`source` points to a local clone of your context repository. Relative paths resolve from the config file; `~` expands to your home directory.

## 2. Create a profile

In the Source Repository, create `profiles/laptop.toml`:

```toml
harnesses = ["codex", "claude-code"]
template = "personal"
packs = ["base", "personal", "macos"]
skills_enable = ["review-worktree"]
skills_disable = ["publish"]
```

The Source Repository also needs an `agentsmith.toml` root config, the selected template family, packs, and skill sources. See [Source Repository layout](/reference/source-layout).

## 3. Preview and synchronize

```sh
asmith global lint
asmith global explain
asmith global diff
asmith global sync
```

`global sync` requires a clean Source Repository with an upstream. It runs `git pull --ff-only`, rebuilds the plan, and writes all global artifacts.

Use `asmith global generate` when the local source is already current and you only want to regenerate.

## Adoption and recovery

Global outputs are protected by hashes stored in `~/.agents/agentsmith/state.toml`. An existing file that agentsmith has never recorded is not overwritten by default. Inspect the diff, then use `--force` once to adopt it:

```sh
asmith global diff
asmith global generate --force
```

`--force` is available only for global generation and synchronization. Project mode intentionally has no force option.
