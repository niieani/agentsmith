---
title: Global setup
description: Synchronize global instructions and skills across machines with a Git-backed profile.
---

Global mode is for personal agent context that follows you across machines. Each host keeps a tiny machine config and selects one profile from a shared Source Repository.

## Quick start: `global init`

When your Source Repository already exists, one command sets up a machine:

```sh
asmith global init git@github.com:me/agent-context.git --profile laptop --schedule
```

It clones the repository to `~/.agents/agentsmith/source`, checks that the `laptop` profile resolves, writes `~/.agents/agentsmith/config.toml`, lints, lists what the first sync will write, runs that sync, and installs a timer that syncs every hour. Use `--source PATH` to clone elsewhere and `--interval 30m` to sync more often.

If the machine already has global files that agentsmith did not write, for example a hand-written `~/.claude/CLAUDE.md`, `init` shows the diff and asks before replacing them. The originals are kept as `CLAUDE.md.agentsmith-<timestamp>`. In scripts, pass `--yes` to accept. Without a terminal and without `--yes`, `init` stops with exit code 5 and prints the command to rerun. To keep text from the original, run `asmith global adopt` after copying it back around the generated content, or move it into a pack.

The scheduled job runs without your SSH agent, so it needs read access that does not prompt. Use a read-only deploy key without a passphrase, or an HTTPS token in a credential helper. `init --schedule` and `global schedule install` warn when the repository is not reachable that way.

```sh
asmith global schedule status   # installed? interval, command, last run
asmith global status --max-age 3h  # for monitoring
```

On Linux, run `loginctl enable-linger $USER` on always-on hosts so the timer runs without a login session.

The rest of this page builds the same setup by hand.

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
harnesses = ["generic", "codex", "claude"]
template = "personal"
packs = ["base", "personal", "macos"]
skills_enable = ["review-worktree"]
skills_disable = ["publish"]
```

`generic` writes global skills to `~/.agents/skills`, where Codex reads them; `codex` writes only `~/.codex/AGENTS.md`. A global skill enabled for `codex` without `generic` is an error. Add `antigravity` to write Antigravity's global instructions as an always-on rule, `~/.gemini/config/rules/agentsmith.md`, and its skills to `~/.gemini/config/skills`; agentsmith never edits your own `GEMINI.md`. See [harness destinations](/reference/configuration#harness-destinations).

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
