---
title: Project maintainer walkthrough
description: Commit shared instructions and generate skills for a Bun service and an iOS app in one monorepo, with your own additions on top.
---

Suppose a monorepo contains a Bun API and an iOS application. The team shares repository conventions, each subtree needs its own commands and skills, and you, the maintainer, already keep templates and packs you like in your Source Repository.

By the end, the repository commits a shared layer that every clone gets, while your personal additions stay on your machine:

```text
acme/
├── AGENTS.md                 shared: committed
├── CLAUDE.md                 shared: committed (@AGENTS.md)
├── AGENTS.override.md        personal: Codex reads it instead of AGENTS.md
├── CLAUDE.local.md           personal: Claude reads it instead of CLAUDE.md
├── services/api/
│   ├── AGENTS.md             shared API additions
│   ├── CLAUDE.md
│   ├── AGENTS.override.md    personal API additions
│   ├── CLAUDE.local.md
│   ├── .agents/skills/       generated, ignored
│   └── .claude/skills/       generated, ignored
└── apps/ios/
    ├── AGENTS.md             shared iOS additions, Codex only
    └── .codex/skills/        generated, ignored
```

What is shared depends on where an input lives, not on which file it ends up in. Everything in the repository's `.config/agentsmith/` is shared, except `*.local.md` files. Everything from your Source Repository is personal. See [committing project instructions](/guides/committing-project-instructions).

The starting point in this walkthrough:

```text
/work/source/                   Source Repository (personal)
├── templates/
│   ├── software/default.md     includes the partial engineering.md
│   ├── service/default.md
│   └── ios/codex.md
├── partials/engineering.md
└── packs/
    ├── base/instructions/workflow/10-base.md
    └── bun/instructions/verification/10-bun.md

/work/acme/
├── package.json                "packageManager": "bun@1.3.0"
├── services/api/src/index.ts
└── apps/ios/README.md
```

## 1. Initialize the repository

Run from the repository root:

```sh
asmith project init --prepare
```

```text
Wrote .config/agentsmith/config.toml for generic, codex, claude, antigravity.
Templates in your Source Repository are personal, so the committed AGENTS.md does not use them. To commit one with the project, run:
  asmith project init --template <name>   (available: ios, service, software)
Added to .gitignore:
  /.agents/skills/*
  !/.agents/skills/.gitkeep
  /.codex/skills/*
  !/.codex/skills/.gitkeep
  /.claude/skills/*
  !/.claude/skills/.gitkeep
  /.agent/skills/
  /.config/agentsmith/**/*.local.md
Created .agents/skills/.gitkeep so the skill folder exists when a session starts.
Created .codex/skills/.gitkeep so the skill folder exists when a session starts.
Created .claude/skills/.gitkeep so the skill folder exists when a session starts.
Running bun add -d asmith
Set scripts.prepare to "asmith project generate".

Next:
  1. Add templates, packs, and skills under .config/agentsmith/, then run bunx asmith project generate.
  2. Commit .config/agentsmith/, .gitignore, the .gitkeep placeholders, and the generated AGENTS.md and CLAUDE.md.
```

No `.agents/`, `.codex/`, `.claude/`, or `.agent/` folder or `GEMINI.md` existed, so init selected all four harnesses. `--prepare` found bun through the `packageManager` field, added `asmith` as a dev dependency, and set `scripts.prepare`, so every `bun install` regenerates skills and personal files with the version the repository pins.

The skill folders are ignored, but each keeps a committed `.gitkeep`. Claude Code only watches skill folders that existed when its session started, so the placeholder lets skills generated during a session appear on the next turn.

## 2. Copy your templates into the project

A template from your Source Repository is personal, so the committed `AGENTS.md` cannot use it. Copy the three templates into the project, where they become shared inputs:

```sh
asmith project init --template software
asmith project init --template service
asmith project init --template ios
```

```text
Copied from the Source Repository:
  .config/agentsmith/templates/software/default.md
  .config/agentsmith/partials/engineering.md
Set template = "project:software" for scope "." in .config/agentsmith/config.toml.

Next:
  1. Add templates, packs, and skills under .config/agentsmith/, then run asmith project generate.
  2. Commit .config/agentsmith/, .gitignore, the .gitkeep placeholders, and the generated AGENTS.md and CLAUDE.md.
```

`software` came with the partial it includes. For `service` and `ios`, init copies the files and, since scope `.` already has a template, prints the `template = "project:service"` line to add to the scope that needs it. Each template keeps the harness variants it has: `ios` has only `codex.md`. Copying never overwrites a project file, and rerunning it changes nothing. From now on the copies are the team's templates; edit them in the repository like any other file. See [copying a template](/reference/commands#copying-a-template-into-the-project).

## 3. Declare the scopes

Replace `.config/agentsmith/config.toml`:

```toml title=".config/agentsmith/config.toml"
harnesses = ["generic", "codex", "claude"]

[[scopes]]
path = "."
template = "project:software"
packs = ["repository", "base"]

[[scopes]]
path = "services/api"
template = "project:service"
packs = ["api", "bun"]
skills_enable = ["service-debug"]

[[scopes]]
path = "apps/ios"
template = "project:ios"
packs = ["ios-app"]
harnesses = ["codex"]
skills_enable = ["simulator-debug"]
```

The root scope is required. Nested pack lists are deltas: they add to inherited context and must not repeat the root's packs. `repository`, `api`, and `ios-app` are project packs; `base` and `bun` come from your Source Repository, so they only reach your personal files. `generic` and `codex` share each scope's `AGENTS.md`; `claude` gets `CLAUDE.md`. See [what each harness gets](/guides/projects-and-scopes#what-each-harness-gets).

## 4. Add the team's packs and skills

```text
.config/agentsmith/
├── config.toml
├── templates/
│   ├── software/default.md
│   ├── service/default.md
│   └── ios/codex.md
├── partials/engineering.md
├── packs/
│   ├── repository/instructions/
│   │   ├── repository/10-layout.md
│   │   └── workflow/10-review.md
│   ├── api/instructions/verification/10-integration-tests.md
│   └── ios-app/instructions/build/10-xcode.md
└── skills/
    ├── service-debug/SKILL.md
    └── simulator-debug/SKILL.md
```

```md title=".config/agentsmith/packs/repository/instructions/repository/10-layout.md"
- Shared packages live under `packages/`.
- Deployable applications live under `apps/` or `services/`.
```

```md title=".config/agentsmith/packs/api/instructions/verification/10-integration-tests.md"
Run `bun test test/integration` after changing request handling or persistence.
```

Instruction-only pack directories need no `pack.toml`. The skills are project skills, so every clone generates them.

`project init` ignores only the root skill folders. Add the same lines for the nested scopes' skill folders, and create their placeholders:

```text title=".gitignore (appended)"
/services/api/.agents/skills/*
!/services/api/.agents/skills/.gitkeep
/services/api/.claude/skills/*
!/services/api/.claude/skills/.gitkeep
/apps/ios/.codex/skills/*
!/apps/ios/.codex/skills/.gitkeep
```

```sh
for d in services/api/.agents/skills services/api/.claude/skills apps/ios/.codex/skills; do
  mkdir -p "$d" && touch "$d/.gitkeep"
done
```

## 5. Preview the result

Run from any directory in the repository:

```sh
asmith project lint
asmith project explain
asmith project diff
```

`explain` traces every planned file to its inputs, and marks each instruction file's layer. It starts:

```text
project plan
Config: /work/acme/.config/agentsmith/config.toml
Source Repository: /work/source
Project: /work/acme

generic+codex .: instruction layer
  destination: /work/acme/AGENTS.md
  layer: shared
  template: /work/acme/.config/agentsmith/templates/software/default.md
  template source: project:software (selected as project:software)
  packs: project:repository
  pack project:repository: /work/acme/.config/agentsmith/packs/repository (selected as repository)
  bytes: 234
  includes: /work/acme/.config/agentsmith/partials/engineering.md
  slot repository: /work/acme/.config/agentsmith/packs/repository/instructions/repository/10-layout.md
  slot workflow: /work/acme/.config/agentsmith/packs/repository/instructions/workflow/10-review.md
codex .: instruction layer
  destination: /work/acme/AGENTS.override.md
  layer: personal
  template: /work/acme/.config/agentsmith/templates/software/default.md
  template source: project:software (selected as project:software)
  packs: project:repository, source:base
  pack project:repository: /work/acme/.config/agentsmith/packs/repository (selected as repository)
  pack source:base: /work/source/packs/base (selected as base)
  bytes: 278
  includes: /work/acme/.config/agentsmith/partials/engineering.md
  slot repository: /work/acme/.config/agentsmith/packs/repository/instructions/repository/10-layout.md
  slot workflow: /work/acme/.config/agentsmith/packs/repository/instructions/workflow/10-review.md, /work/source/packs/base/instructions/workflow/10-base.md
```

`diff` shows exactly what will change on disk.

## 6. Generate and commit the shared layer

```sh
asmith project generate
git status --short --untracked-files=all
```

```text
 M package.json
?? .agents/skills/.gitkeep
?? .claude/skills/.gitkeep
?? .codex/skills/.gitkeep
?? .config/agentsmith/config.toml
?? .config/agentsmith/packs/api/instructions/verification/10-integration-tests.md
?? .config/agentsmith/packs/ios-app/instructions/build/10-xcode.md
?? .config/agentsmith/packs/repository/instructions/repository/10-layout.md
?? .config/agentsmith/packs/repository/instructions/workflow/10-review.md
?? .config/agentsmith/partials/engineering.md
?? .config/agentsmith/skills/service-debug/SKILL.md
?? .config/agentsmith/skills/simulator-debug/SKILL.md
?? .config/agentsmith/templates/ios/codex.md
?? .config/agentsmith/templates/service/default.md
?? .config/agentsmith/templates/software/default.md
?? .gitignore
?? AGENTS.md
?? CLAUDE.md
?? apps/ios/.codex/skills/.gitkeep
?? apps/ios/AGENTS.md
?? services/api/.agents/skills/.gitkeep
?? services/api/.claude/skills/.gitkeep
?? services/api/AGENTS.md
?? services/api/CLAUDE.md
```

Git sees only what the team should review: the configuration, the shared instruction files, and the placeholders. The generated skills (`services/api/.agents/skills/service-debug/`, `services/api/.claude/skills/service-debug/`, `apps/ios/.codex/skills/simulator-debug/`) are ignored. The personal files are listed in `.git/info/exclude`.

The shared `AGENTS.md` holds only shared inputs:

```md title="AGENTS.md"
# Repository

## Engineering

Make small, reviewable changes.

## Conventions

- Shared packages live under `packages/`.
- Deployable applications live under `apps/` or `services/`.

## Workflow

Open a pull request for every change.
```

`CLAUDE.md` is the one-line import `@AGENTS.md`, since its content would be identical. Commit:

```sh
git add -A
git commit -m "chore: add agent instructions"
```

## 7. Keep your own additions on top

Your `base` and `bun` packs never touch the shared files. They render into the personal layer:

```md title="AGENTS.override.md"
# Repository

...

## Workflow

Open a pull request for every change.

Explain trade-offs before large refactors.
```

Codex reads `AGENTS.override.md` instead of `AGENTS.md`. `CLAUDE.local.md` holds `@AGENTS.override.md`, and `.claude/settings.local.json` lists the shared `CLAUDE.md` in `claudeMdExcludes`, so Claude Code reads only your version. `apps/ios` has no personal input, so it has no personal file.

For a note that belongs to this repository only, write a `*.local.md` snippet in a project pack. `.gitignore` keeps it out of Git, and only the personal layer changes:

```sh
echo "I run the slow suite with make test-all." > .config/agentsmith/packs/api/instructions/verification/90-mine.local.md
asmith project diff
```

```diff
@@ -7,0 +7,2 @@
+I run the slow suite with make test-all.
+
```

The diff touches only `services/api/AGENTS.override.md`. agentsmith lists the personal files in one block of `.git/info/exclude`, which every worktree of the repository shares, so it only ever adds lines there. The file now ends with:

```text title=".git/info/exclude"
# BEGIN agentsmith: personal files, shared by every worktree. agentsmith adds lines here and never removes them.
/AGENTS.override.md
/CLAUDE.local.md
/services/api/AGENTS.override.md
/services/api/CLAUDE.local.md
/.claude/settings.local.json
# END agentsmith
```

## 8. Teammates and CI

A teammate's clone has no machine config. `bun install` runs the `prepare` script, which renders the shared layer and the shared skills, and reports each of your personal packs it leaves out:

```text
NOTICE personal-input-skipped: Skipped pack "base": it is not a shared project input, and no Source Repository is configured to provide it
NOTICE personal-input-skipped: Skipped pack "bun": it is not a shared project input, and no Source Repository is configured to provide it
Generated 8 file(s); removed 0 stale file(s).
```

The clone's `git status` stays clean, and its skills are the same as yours: `service-debug` and `simulator-debug`.

In CI:

```sh
asmith project lint --warnings-as-errors
asmith project diff
```

Notices never fail a run, even with `--warnings-as-errors`. `diff` prints `No changes.` when the committed files match the configuration; anything else means someone changed an input without regenerating.

## 9. Understand what an agent sees

An agent working in `services/api` sees:

1. its global harness instructions;
2. the repository `AGENTS.md` or `CLAUDE.md` (yours: `AGENTS.override.md` or `CLAUDE.local.md`);
3. `services/api/AGENTS.md` or `services/api/CLAUDE.md` (yours: the personal files beside them);
4. `service-debug`, from `services/api/.agents/skills` (Codex and other agents) and `services/api/.claude/skills`.

An agent working in `apps/ios` gets the root layer plus the iOS Codex layer. No nested Claude file is generated because that scope restricts its harnesses to Codex, and `simulator-debug` goes to `apps/ios/.codex/skills` because that scope does not select `generic`.

## 10. Let safety checks catch drift

If someone edits the generated `services/api/AGENTS.md` by hand, `project generate` refuses to replace it and exits 1 before writing anything:

```text
Refusing to replace modified and edited project destination: /work/acme/services/api/AGENTS.md
```

Move the change into a template or pack, or discard it with Git.

If a later config removes the `apps/ios` scope, the next generation deletes `apps/ios/AGENTS.md` and the generated `simulator-debug` skill, as long as neither was edited; commit the deletion of `apps/ios/AGENTS.md`. agentsmith never deletes files it did not write.

Project mode never pulls your Source Repository. After it changes, run `asmith project diff` and `asmith project generate` to update your personal files; the shared files change only through the repository's own inputs.
