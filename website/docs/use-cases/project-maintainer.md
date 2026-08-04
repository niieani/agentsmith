---
title: Project maintainer walkthrough
description: Generate layered instructions and skills for a Bun service and an iOS app in one monorepo.
---

Suppose a monorepo contains a Bun API and an iOS application. Both use GitHub and share repository conventions, but each subtree needs different commands, verification, and skills.

The desired context follows the directory where an agent works:

```text
acme/
├── AGENTS.md                 shared repository context
├── CLAUDE.md
├── services/api/
│   ├── AGENTS.md             API-specific additions
│   └── CLAUDE.md
└── apps/ios/
    └── AGENTS.md             iOS additions for Codex only
```

## 1. Declare the repository and subtree scopes

Create `.config/agentsmith/config.toml`:

```toml
harnesses = ["codex", "claude-code"]

[budgets]
instruction_layer_bytes = 20000
effective_instruction_bytes = 32000
skill_markdown_bytes = 16000

[[scopes]]
path = "."
template = "software"
packs = ["base", "github", "repository"]

[[scopes]]
path = "services/api"
template = "service"
packs = ["bun", "api"]
skills_enable = ["service-debug"]

[[scopes]]
path = "apps/ios"
template = "ios"
packs = ["swift", "ios"]
harnesses = ["codex"]
skills_enable = ["simulator-debug"]
```

The root scope is required. Nested pack lists are deltas: they add to inherited context and must not repeat `base` or `github`.

## 2. Keep universal concerns reusable

Reusable matches come from the maintainer's configured Source Repository:

- `base` supplies general engineering workflow;
- `github` supplies issue and review behavior;
- `bun`, `swift`, and `ios` supply ecosystem-specific guidance;
- `software`, `service`, and `ios` define appropriate document structures.

This content can be improved once and reused by many repositories.

## 3. Keep repository-specific policy in the repository

Project-owned sources live below `.config/agentsmith/`. Their unqualified names resolve automatically:

```text
.config/agentsmith/
├── config.toml
└── packs/
    ├── repository/
    │   └── instructions/
    │       └── repository/
    │           └── 10-layout.md
    └── api/
        └── instructions/
            └── verification/
                └── 10-integration-tests.md
```

```md title=".config/agentsmith/packs/repository/instructions/repository/10-layout.md"
- Shared packages live under `packages/`.
- Deployable applications live under `apps/` or `services/`.
- Architectural decisions live under `docs/adr/`.
```

```md title=".config/agentsmith/packs/api/instructions/verification/10-integration-tests.md"
Run `bun test test/integration` after changing request handling, persistence, or authentication.
```

These instruction-only pack directories need no `pack.toml`. Checking the sources into the repository gives every maintainer the same project-specific inputs. If a maintainer also has a shared pack with the same name, agentsmith composes shared contributions first and project contributions second; `project:repository` selects only the project pack when that distinction is intentional.

## 4. Preview the effective result

Run from any descendant of the project:

```sh
asmith project lint
asmith project explain
asmith project diff
```

agentsmith walks upward to find `.config/agentsmith/config.toml`.

Read `explain` as a dependency trace:

- which instruction layer is planned for each scope and harness;
- which template and inherited pack chain produced it;
- which pack enabled each skill;
- which snippets filled each slot;
- how large each layer and effective chain will be.

`diff` answers the complementary question: exactly what will change on disk?

## 5. Generate and commit

```sh
asmith project generate
git status --short
git diff -- AGENTS.md CLAUDE.md services/api apps/ios
git add .config/agentsmith AGENTS.md CLAUDE.md services/api apps/ios
git commit -m "chore: generate agent context"
```

Generated context is committed so every clone and every agent sees it without having agentsmith installed at runtime.

## 6. Understand what an agent sees

An agent working at the repository root sees the root instruction layer and root skills.

An agent working in `services/api` sees:

1. global harness instructions;
2. repository `AGENTS.md` or `CLAUDE.md`;
3. `services/api/AGENTS.md` or `services/api/CLAUDE.md`;
4. visible global, repository, and API skill roots.

An agent working in `apps/ios` gets the root layer plus the iOS Codex layer. No nested Claude file is generated because that scope restricts its harnesses to Codex.

## 7. Review a source update

After the shared Source Repository changes, project mode does not pull it. Update that repository using your normal workflow, then review:

```sh
asmith project lint
asmith project diff
asmith project generate
```

This separation is intentional: global synchronization owns fetching personal sources; project generation is a deterministic local build.

## 8. Let safety checks catch drift

If someone manually edits a generated `services/api/AGENTS.md`, Git reports the path dirty and generation stops before writing anything. The maintainer must either preserve the change by moving it into a template/pack or discard it intentionally through normal Git operations.

If a later config removes the API scope, agentsmith recognizes its previously generated paths as stale, but deletes them only while Git reports them clean. It never deletes unrecorded paths.

## 9. Add CI validation

```sh
asmith project lint --warnings-as-errors
asmith project diff
```

Lint catches invalid composition and turns budget warnings into failures. A nonempty diff can be used as a signal that checked-in generated context needs regeneration.

## What this example used

- **Repository and subtree scopes** follow native harness inheritance.
- **Harness subsets** avoid generating irrelevant nested artifacts.
- **Shared packs** reuse ecosystem knowledge across repositories.
- **Project packs** keep local architecture and commands with the code.
- **Effective-size budgets** guard the whole inherited context chain.
- **Explain and diff** support review at provenance and byte levels.
- **Git-aware generation** protects hand edits and stale artifacts.
