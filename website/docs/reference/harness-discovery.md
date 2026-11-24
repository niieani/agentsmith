---
title: Harness discovery
description: Which instruction files and skill roots Codex, Claude Code, and Antigravity read, and how agentsmith maps them.
---

agentsmith writes artifacts where each harness already looks. This page records what each harness reads, in what order, and what happens when two files or skills overlap. The [configuration reference](/reference/configuration#harness-destinations) lists where agentsmith writes for each harness.

Researched November 2026. Codex facts come from the Codex CLI source (commit `ac54a05`); Claude Code facts come from its official [memory](https://code.claude.com/docs/en/memory) and [skills](https://code.claude.com/docs/en/skills) documentation; Antigravity facts were verified by running `agy` 1.5.13 and 1.5.15. Harnesses change; see [Caveats](#caveats) for points that were not confirmed.

## Summary

| | Codex | Claude Code | Antigravity | `generic` target |
| --- | --- | --- | --- | --- |
| Global instructions | `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`) | `~/.claude/CLAUDE.md` | `~/.gemini/GEMINI.md`, `~/.gemini/AGENTS.md`, `~/.gemini/config/GEMINI.md`, `~/.gemini/config/AGENTS.md`, `~/.gemini/config/rules/*.md` | none |
| Project instructions | `AGENTS.md` in each directory from the project root to the working directory | `CLAUDE.md` in the working directory and every directory above it, plus subdirectories on demand | `AGENTS.md`, `GEMINI.md`, and always-on `.agents/rules/*.md` from the working directory up to the repository root | `<scope>/AGENTS.md` |
| Instruction files combine by | concatenation, root first | concatenation, outermost first | all load; nothing overrides | — |
| Global skills | `~/.agents/skills`; `~/.codex/skills` (deprecated) | `~/.claude/skills` | `~/.gemini/config/skills`, `~/.gemini/skills` | `~/.agents/skills` |
| Project skills | `.agents/skills` and `.codex/skills` in each directory from the project root to the working directory | `.claude/skills` in the working directory and every parent up to the repository root, plus subdirectories on demand | `.agents/skills`, `.agent/skills`, `_agents/skills`, `_agent/skills` | `<scope>/.agents/skills` |
| Same skill name twice | both load; a plain `$name` mention selects neither | personal wins over project | one wins by priority; `.agent/skills` beats `.agents/skills` | — |
| Reads `.agents/` | skills only | nothing | project skills and rules; not `~/.agents/skills` | — |

`generic` is not a runtime. It targets the shared `.agents/` convention that Codex and other agents read.

## Codex

### Instruction files

- **Global:** Codex reads `$CODEX_HOME/AGENTS.override.md` if it exists and is not blank, otherwise `$CODEX_HOME/AGENTS.md`. Only one is used.
- **Project:** Codex walks from the working directory up to the project root, the nearest directory containing `.git` by default. In each directory from the root down to the working directory it takes the first of `AGENTS.override.md`, `AGENTS.md`, and any configured fallback filenames that exists, then concatenates them root first.
- **Override files shadow:** an `AGENTS.override.md` hides the `AGENTS.md` beside it. In a project directory even an *empty* override wins, because the choice is made on existence. agentsmith uses this for the personal layer: it writes `AGENTS.override.md` with the shared layer plus personal inputs, and treats an `AGENTS.override.md` it did not write as an error.
- **Below the working directory:** never read. A nested scope's `AGENTS.md` reaches Codex only when Codex starts at or below that scope.
- **Order:** global instructions first, then project files from root to working directory.
- **Size:** project files share one 32 KiB budget by default (`project_doc_max_bytes`). Codex truncates the file that overflows it and drops the rest. Untrusted projects, or a budget of 0, load no project files at all. agentsmith warns when a project chain exceeds 32 KiB.
- **Imports:** none. Codex has no `@path` syntax.

### Skills

Codex reads these roots:

- `.codex/skills` in every directory from the project root to the working directory that has a `.codex/` folder;
- `.agents/skills` in every directory from the project root to the working directory;
- `~/.agents/skills`;
- `$CODEX_HOME/skills`, marked deprecated in the source and kept for backward compatibility;
- system, admin, and plugin roots, which agentsmith does not manage.

Codex removes duplicates **by path only**. Two different `SKILL.md` files with the same `name` both load, and a plain `$name` mention then resolves to nothing because the name is ambiguous. Selecting a skill by path still works. The list is sorted with repository skills before user skills, but nothing overrides anything.

## Claude Code

### Instruction files

- **Global:** `~/.claude/CLAUDE.md` and `~/.claude/rules/**/*.md`, always loaded. A managed policy `CLAUDE.md` loads before them.
- **Project:** `CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md` in the working directory and every directory above it, concatenated from the outermost directory inward. Files in subdirectories below the working directory load when Claude first reads or edits a file there.
- **Imports:** `@path` imports work with relative and absolute paths, up to four hops deep. Imports inside code spans and fences are ignored.
- **Size:** files over 4 MiB are skipped; files loaded on demand are truncated at about 40,000 characters with a 200K context window.

#### `AGENTS.md` fallback

Claude Code v2.1.277 and later can read `AGENTS.md`, controlled by the **Project instructions** setting (`/config`). It is honored only in user, `--settings`, and managed settings, never in project settings.

| Value | Behavior |
| --- | --- |
| `claude-md-or-agents-md` (default) | Read `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md` exists in the working directory or any directory above it. |
| `claude-md-and-agents-md` | Read each directory's `CLAUDE.md`, then its `AGENTS.md`. |
| `claude-md` | Never read `AGENTS.md`. |
| `managed-only` | Read only managed instructions. |

The fallback is fragile: a parent repository's `CLAUDE.md`, a personal `CLAUDE.local.md`, a user setting, an older version, or a disabled built-in plugin all turn it off. A `CLAUDE.md` containing `@AGENTS.md` is never loaded twice under any setting.

#### Excluding a `CLAUDE.md`

`claudeMdExcludes` in a settings file lists `CLAUDE.md` files Claude Code skips, by absolute path (verified on Claude Code 2.1.322). For a directory whose `CLAUDE.md` is excluded and whose `CLAUDE.local.md` exists, Claude loads only `CLAUDE.local.md`, and does not fall back to `AGENTS.md`. Without the `CLAUDE.local.md`, excluding `CLAUDE.md` makes Claude fall back to `AGENTS.md`, so agentsmith never leaves an exclude behind without the local file. Nested directories behave the same way. A missing `@import` target is skipped silently.

agentsmith uses this for the personal layer: it writes `CLAUDE.local.md` with every input and adds the `CLAUDE.md` beside it to `claudeMdExcludes` in `<project>/.claude/settings.local.json`.

agentsmith always writes `CLAUDE.md` for a project scope that selects `claude` when the shared inputs define its template. When its content would equal the generated `AGENTS.md` beside it, the file contains only `@AGENTS.md`. Set `claude_import_agents_md = false` in the project configuration to write the full content instead.

### Skills

Claude Code reads `~/.claude/skills`, `.claude/skills` in the working directory and every parent up to the repository root, `.claude/skills` in subdirectories on demand, added directories, plugins, and managed roots.

When the same name appears more than once, enterprise wins over personal, and personal wins over project: a skill in `~/.claude/skills` beats one in the project's `.claude/skills`. This is the opposite of Codex, which keeps both. agentsmith rejects the same skill name at global and project scope rather than relying on either rule.

Claude Code reads nothing under `.agents/`, so `claude` keeps its own `~/.claude/` and `.claude/` destinations.

## Antigravity

Verified by running `agy` 1.5.13 (November 22, 2026) in throwaway repositories, and the skill priority with 1.5.15.

### Instruction files

- **Cumulative:** every instruction file Antigravity finds loads. No file overrides, shadows, or excludes another, and `rules.json` `exclude` does not affect `AGENTS.md` or `GEMINI.md`.
- **Project:** every `AGENTS.md`, `GEMINI.md`, and `.agents/rules/*.md` whose front matter says `trigger: always_on`, from the working directory up to the repository root. `AGENTS.override.md`, `CLAUDE.md`, and `GEMINI.local.md` are not read.
- **Global:** `~/.gemini/GEMINI.md`, `~/.gemini/AGENTS.md`, `~/.gemini/config/GEMINI.md`, `~/.gemini/config/AGENTS.md`, and `~/.gemini/config/rules/*.md` all load.

agentsmith writes the global layer to a rule it owns, `~/.gemini/config/rules/agentsmith.md`, with `trigger: always_on` front matter, so it never edits a `GEMINI.md` or `AGENTS.md` you keep there. In a project Antigravity reads the shared `<scope>/AGENTS.md`; agentsmith never writes `GEMINI.md`, since both would load. Because nothing can replace the shared file, the personal layer is an always-on rule, `<scope>/.agents/rules/agentsmith-personal.md`, holding only the personal additions and saying that they take precedence. Antigravity-specific snippets from the project's own inputs go to a committed rule, `<scope>/.agents/rules/agentsmith.md`; only Antigravity reads `.agents/rules/`. `upstream = "replace"` cannot hide upstream files from Antigravity.

### Skills

Antigravity reads `.agents/skills`, `.agent/skills`, `_agents/skills`, and `_agent/skills` in a project, and `~/.gemini/config/skills` and `~/.gemini/skills` globally. It does not read `.claude/skills`, `.codex/skills`, or `.gemini/skills` in a project, nor `~/.agents/skills` or `~/.claude/skills`.

When the same skill name exists in two roots, one copy wins by priority and the other is not loaded. With a skill in both `.agent/skills` and `.agents/skills`, `agy` listed and used only the `.agent/skills` copy in five of five runs, whichever was created first. A skill created mid-session is visible on the next turn even if its folder did not exist when the session started.

## How agentsmith places skills

Each harness adapter declares where it writes skills and every root it reads. For a skill enabled for some harnesses at one scope, agentsmith writes the fewest copies that let each of those harnesses see it exactly once:

| Enabled for | Project scope | Global scope |
| --- | --- | --- |
| `generic` (with or without `codex`) | `.agents/skills` | `~/.agents/skills` |
| `codex` without `generic` | `.codex/skills` | error: enable it for `generic` |
| `claude` | `.claude/skills` | `~/.claude/skills` |
| `antigravity` | `.agents/skills` | `~/.gemini/config/skills` |
| `antigravity`, with Antigravity skill-slot content | `.agent/skills`, plus `.agents/skills` for the other harnesses | `~/.gemini/config/skills` |

Harness-specific skill-slot content (`skill-slots/harnesses/<harness>/`) renders only into a root that one harness alone reads. A skill in `.agents/skills` is read by Codex too, so Codex-specific content consumed by it is an error. To ship Codex-specific content, disable the skill for `generic` with `[harness_skills.generic]` so it lands in `.codex/skills`. Antigravity-specific content needs no such step: the skill gets its own copy in `.agent/skills`, which Antigravity alone reads and prefers over `.agents/skills`.

Collision checks use the same data. A planned or unmanaged skill in `.codex/skills` collides with a same-named skill in `.agents/skills` on the same scope chain when `codex` is selected.

## Caveats

These points were not confirmed:

- whether Codex filters an untrusted project's `.codex/skills`; its project `AGENTS.md` files are skipped;
- that Codex probes only the working directory's `.agents/skills` when no project root marker such as `.git` exists;
- whether Claude Code's parent walk for `CLAUDE.md` stops at the repository root or the filesystem root, which matters for a `~/CLAUDE.md` when projects live under the home directory;
- what Claude Code does with the same skill name in two ancestor `.claude/skills` roots; only root-versus-nested is documented, and both load;
- whether Claude Code reads `~/.claude/AGENTS.md`;
- that Claude Code ignores `.agents/skills`; this rests on its absence from the skills documentation;
- Codex facts come from source at one commit and were not checked against released versions or OpenAI's documentation;
- Antigravity facts come from observing `agy` behavior, not from documentation or source; the priority among `_agents/skills`, `_agent/skills`, and the global roots was not tested.
