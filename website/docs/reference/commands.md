---
title: Command reference
description: Every asmith command, option, and intended workflow.
---

## Global commands

| Command | Purpose |
| --- | --- |
| `asmith global sync [--config PATH] [--force]` | Require clean source, run `git pull --ff-only`, then generate. |
| `asmith global generate [--config PATH] [--force]` | Generate from the current local source without pulling. |
| `asmith global diff [--config PATH]` | Show prospective writes and stale deletions. |
| `asmith global lint [--config PATH] [--warnings-as-errors]` | Validate without writing. |
| `asmith global explain [--config PATH] [--json]` | Show artifacts, provenance, sizes, slots, and includes. |

The default machine config is `~/.agents/agentsmith/config.toml`.

## Project commands

| Command | Purpose |
| --- | --- |
| `asmith project generate [--project PATH]` | Safely generate project artifacts. |
| `asmith project diff [--project PATH]` | Show prospective project changes without writing. |
| `asmith project lint [--project PATH] [--warnings-as-errors]` | Validate project composition. |
| `asmith project explain [--project PATH] [--json]` | Explain the project plan and provenance. |

Starting from `--project` or the current directory, agentsmith searches ancestors for `.config/agentsmith/config.toml`.

## Exit behavior

Commands exit nonzero for configuration, validation, planning, preflight, synchronization, or application errors. Warnings succeed unless `--warnings-as-errors` is set.

`diff`, `lint`, and `explain` do not write generated artifacts. Project commands never pull Git.
