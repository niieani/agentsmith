---
title: Feature cookbook
description: Problem-first examples showing when each agentsmith feature earns its place.
---

Use this page when you understand the basic model but are deciding where a piece of context belongs. Each recipe starts with a concrete maintenance problem and shows the smallest agentsmith feature that solves it.

## Put content in the right section with a slot

**Problem:** macOS guidance, Git policy, and verification commands all need to extend one document, but straight concatenation would produce a poorly ordered instruction file.

Define the order in a template:

```md title="templates/personal/default.md"
# Working agreement

## Git

<!-- agentsmith:slot git -->

## Tools

<!-- agentsmith:slot tools -->

## Verification

<!-- agentsmith:slot verification -->
```

Then let unrelated packs target the right section:

```text
packs/github/instructions/git/10-github.md
packs/macos/instructions/tools/10-homebrew.md
packs/bun/instructions/verification/10-tests.md
```

**Why it helps:** document structure remains readable and stable while concerns remain independently selectable.

## Make missing policy a build error

**Problem:** every generated project agreement must say how to verify changes. An empty section would look valid but provide no protection.

```md
## Verification

<!-- agentsmith:required-slot verification -->
```

A profile or scope with no selected verification contribution fails lint and generation.

Use ordinary `slot` for genuinely optional content. Use `required-slot` when a template or skill promises that the selected packs will supply a policy.

**Why it helps:** omissions become deterministic build failures instead of incomplete agent behavior discovered later.

## Reuse a checklist with an include

**Problem:** several skills need the same “confirm before destructive action” checklist. Copying it creates version drift; asking one skill to invoke another adds runtime uncertainty.

Create a body partial:

```md title="partials/safety/confirm-destructive-action.md"
Before a destructive action:

1. State exactly what will be removed or replaced.
2. Confirm the action is within the user's request.
3. Preserve unrelated work and provide a recovery path when possible.
```

Include it below a heading in any template or skill:

```md
## Safety check

<!-- agentsmith:include safety/confirm-destructive-action.md -->
```

**Generated result:** the checklist is inlined into each artifact. The agent reads one self-contained file and never needs to resolve the partial.

## Reuse a whole section at different heading depths

**Problem:** a substantial section has useful internal headings, but one template needs it under H2 and another skill needs it under H3.

Write the partial as a section rooted at H1:

```md title="partials/review/evidence.md"
# Evidence

Record the behavior you observed and the command that produced it.

## Distinguish inference

Label conclusions that are inferred rather than directly observed.
```

Include it after the nearest parent heading:

```md
## Review process

<!-- agentsmith:include review/evidence.md -->
```

agentsmith rebases `# Evidence` to `### Evidence` and preserves the relative child depth. If the parent later moves, the partial follows automatically.

**Why it helps:** the partial owns its internal structure while the consumer owns where that structure sits.

## Adapt one template to two harnesses

**Problem:** Codex and Claude Code share most guidance, but one harness needs different tool instructions or terminology.

```text
templates/software/
├── default.md
├── codex.md
└── claude-code.md
```

Use only `default.md` while the structure is shared. Add a harness-specific file when the whole structure genuinely differs; it wins over the fallback for that harness.

For a smaller difference, keep one template and add a harness-specific pack contribution:

```text
packs/review/instructions/tools/10-common.md
packs/review/instructions/codex/tools/20-codex.md
```

**Why it helps:** common guidance stays common, while the smallest necessary seam carries the harness difference.

## Give a laptop and server different context

**Problem:** two machines share personal preferences, but have different operating systems, tools, or responsibilities.

```toml title="profiles/laptop.toml"
version = 1
harnesses = ["codex", "claude-code"]
template = "personal"
packs = ["base", "macos", "ios"]
```

```toml title="profiles/server.toml"
version = 1
harnesses = ["codex"]
template = "personal"
packs = ["base", "linux", "operations"]
```

Each machine's local config selects one profile. The shared Source Repository still owns both profiles and all reusable packs.

**Why it helps:** machine identity is local, but machine definitions remain reviewable and synchronized.

## Add repository-only guidance without polluting shared packs

**Problem:** one repository has a unique deployment process that should travel with the code, not become a personal global convention.

```text
.config/agentsmith/
├── config.toml
└── packs/
    └── deployment/
        ├── pack.toml
        └── instructions/
            └── deployment/
                └── 10-production.md
```

Select the explicit project-owned Source ID:

```toml
packs = ["base", "@project/deployment"]
```

**Why it helps:** contributors review project context with project code, and the `@project` namespace makes ownership unambiguous.

## Layer special guidance into one monorepo subtree

**Problem:** the root repository uses Bun, but `apps/ios` needs Swift and simulator instructions without burdening agents working elsewhere.

```toml
[[scopes]]
path = "."
template = "software"
packs = ["base", "bun"]

[[scopes]]
path = "apps/ios"
template = "ios"
packs = ["swift", "ios"]
```

The nested scope emits its own instruction layer. Native harness discovery combines it with ancestor context only when an agent works below `apps/ios`.

**Why it helps:** specialized context stays close to the work and does not consume attention or context budget elsewhere.

## Auto-enable a skill with the tool it serves

**Problem:** every project using GitHub should have an issue-triage skill, but maintainers should not need to remember a second configuration list.

```toml title="packs/github/pack.toml"
version = 1
skills = ["triage-issue"]
```

Selecting `github` now enables the skill. A project can still opt out:

```toml
skills_disable = ["triage-issue"]
```

**Why it helps:** the capability follows the concern that makes it relevant, while the final consumer retains control.

## Keep one skill while changing its integration

**Problem:** a skill's reasoning workflow is stable, but each project needs to bring its own tracker instructions.

Declare a `tracker` slot in the shared `skills/triage-issue/SKILL.md`. A project can fill it from a project-owned pack:

```text
.config/agentsmith/packs/acme-tracker/
├── pack.toml
└── skill-slots/
    └── tracker/
        └── 10-acme.md
```

```toml
[[scopes]]
path = "."
template = "software"
packs = ["base", "@project/acme-tracker"]
skills_enable = ["triage-issue", "create-issue"]
```

The `@project/acme-tracker` pack names no consumers. agentsmith embeds `10-acme.md` into both enabled skills because both declare the `tracker` slot.

The same pattern works with reusable shared packs such as `github` or `linear`; pack selection chooses the integration. The generated public skill remains `triage-issue`. See the [full skill author walkthrough](/use-cases/skill-author#6-bring-your-own-tracker-instructions).

**Why it helps:** skill authors maintain independent workflows, while each project selects one tracker implementation and reuses it across all compatible skills.

## Preview exact changes without risking output

**Problem:** a shared pack changed, and you want to review its effects before replacing committed `AGENTS.md`, `CLAUDE.md`, or skills.

```sh
asmith project lint
asmith project explain
asmith project diff
```

- `lint` answers “is the model valid?”
- `explain` answers “why is this content planned?”
- `diff` answers “what bytes will change?”

None writes generated artifacts.

**Why it helps:** structural, provenance, and textual review are separate tools instead of one opaque generation step.

## Find why a skill appeared

**Problem:** a generated skill was auto-enabled indirectly and the project config does not list it.

```sh
asmith project explain
```

The explanation reports the skill Source ID, public name, destination, scope, enabling packs, explicit enablement, exclusions, files, slot contributions, and sizes.

**Why it helps:** additive composition remains debuggable as the number of packs grows.

## Catch context growth before the harness does

**Problem:** individually reasonable snippets combine into an oversized inherited context chain.

```toml
[budgets]
instruction_layer_bytes = 20000
effective_instruction_bytes = 32000
skill_markdown_bytes = 16000
```

Budgets warn rather than truncate. In CI:

```sh
asmith project lint --warnings-as-errors
```

**Why it helps:** maintainers get a reviewable signal and decide what to shorten or move into an on-demand skill; agentsmith never silently cuts instructions.

## Protect an accidental hand edit

**Problem:** someone edited generated `AGENTS.md` directly and then runs generation.

Project generation checks Git status for each planned destination. A modified, staged, conflicted, untracked, or ignored existing output stops the entire plan. There is no project force flag.

Move the valuable change into its source template or pack, or resolve the generated file intentionally with Git, then regenerate.

**Why it helps:** regeneration cannot silently erase work, and generated artifacts remain traceable to their sources.

## Add a private machine-only note

**Problem:** one host has a local quirk that should participate in composition but must not be committed.

Add a Git ignore rule for `*.local.md`, then place a file such as:

```text
packs/server/instructions/tools/90-storage.local.md
```

agentsmith scans all Markdown in selected source directories, including ignored local files. `global sync` permits ignored source while rejecting nonignored untracked changes.

**Why it helps:** exceptional host notes use the same composition pipeline without creating a public profile for a private detail.

## Choose the next guide

- For a complete cross-machine setup, follow [Personal user walkthrough](/use-cases/personal-user).
- For a composed skill, follow [Skill author walkthrough](/use-cases/skill-author).
- For a monorepo, follow [Project maintainer walkthrough](/use-cases/project-maintainer).
- For exact schema and syntax, return to [Configuration reference](/reference/configuration) and [Composition directives](/reference/directives).
