---
title: Personal user walkthrough
description: Keep Codex and Claude Code context synchronized across a laptop and a long-running workstation.
---

Suppose you use a MacBook for app development and a long-running workstation for server work. Both run Codex and Claude Code. Most of your preferences are shared, but only the laptop needs iOS guidance and only the workstation needs server operations guidance.

The goal is not one giant file copied everywhere. The goal is one reusable source repository with a small profile per machine.

## 1. Create the context repository

Create a Git repository with this shape:

```text
agent-context/
├── agentsmith.toml
├── profiles/
│   ├── laptop.toml
│   └── workstation.toml
├── templates/
│   └── personal/
│       └── default.md
└── packs/
    ├── base/
    │   └── instructions/
    │       └── workflow/
    │           └── 10-base.md
    ├── ios/
    │   └── instructions/
    │       └── tools/
    │           └── 10-xcode.md
    └── server/
        └── instructions/
            └── tools/
                └── 10-server.md
```

Start the root config with optional size guardrails:

```toml title="agentsmith.toml"
[budgets]
instruction_layer_bytes = 24576
skill_markdown_bytes = 16384
```

## 2. Define the document once

The template controls structure, while packs supply the variable details:

```md title="templates/personal/default.md"
# Personal working agreement

## Workflow

<!-- agentsmith:required-slot workflow -->

## Tools available on this machine

<!-- agentsmith:slot tools -->
```

The required workflow slot prevents a profile from generating an empty working agreement. The tools slot is optional because not every machine needs extra tool guidance.

## 3. Put concerns into packs

An instruction-only pack is just a directory:

```md title="packs/base/instructions/workflow/10-base.md"
- Inspect the repository before editing.
- Preserve unrelated worktree changes.
- Run focused verification before reporting completion.
```

The laptop-specific pack contributes to the same template without replacing it:

```md title="packs/ios/instructions/tools/10-xcode.md"
- Use the checked-in Xcode project and the repository's selected scheme.
- Prefer Simulator for routine iteration.
```

The server pack can describe its own environment independently:

```md title="packs/server/instructions/tools/10-server.md"
- Treat background services as long-running processes.
- Check existing listeners and logs before restarting a service.
```

None of these packs needs `pack.toml`. That optional manifest exists only for packs that enable skills.

## 4. Select packs per machine

```toml title="profiles/laptop.toml"
harnesses = ["codex", "claude-code"]
template = "personal"
packs = ["base", "ios"]
```

```toml title="profiles/workstation.toml"
harnesses = ["codex", "claude-code"]
template = "personal"
packs = ["base", "server"]
```

Pack order is rendered order. Both machines receive `base`; each adds only its relevant tool section.

## 5. Point each machine at its profile

Clone the repository to the same conventional location on each machine, then create the local machine config.

On the laptop:

```toml title="~/.agents/agentsmith/config.toml"
source = "~/.agents/agentsmith/source"
profile = "laptop"
```

On the workstation, use the same file with `profile = "workstation"`.

The machine config is intentionally local. It answers “which machine am I?” while the Git repository answers “what profiles and reusable content exist?”

## 6. Preview before writing

```sh
asmith global lint
asmith global explain
asmith global diff
```

`explain` is especially useful here: it shows the selected profile, template, packs, output destinations, slots, and byte sizes. If an unexpected instruction appears, its provenance tells you which pack added it.

## 7. Synchronize

```sh
asmith global sync
```

The command requires a clean Source Repository, performs `git pull --ff-only`, and then generates:

```text
~/.codex/AGENTS.md
~/.claude/CLAUDE.md
```

If selected packs enable skills, agentsmith also generates them under the native global skill roots.

Run global sync manually, from a scheduler, or from whatever machine-management workflow fits your environment. It does not depend on login or reboot, so it works for long-running hosts.

## 8. Make a change once

To add a shared rule, edit the `base` snippet, commit, and push the Source Repository. On each machine:

```sh
asmith global diff
asmith global sync
```

If a generated global file was hand-edited, agentsmith detects that its content no longer matches recorded state and stops. Review the edit instead of silently losing it.

## What this example used

- **Profiles** select different behavior per machine.
- **Packs** keep shared, iOS, and server concerns independent.
- **Slots** place those concerns inside the right Markdown sections.
- **Required slots** prevent an incomplete baseline.
- **Diff and explain** make the result reviewable.
- **Global sync** updates long-running machines without relying on shell login.
