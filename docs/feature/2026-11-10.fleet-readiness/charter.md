# Fleet readiness

## Goal

One person can keep many long-running machines converged on a shared Source Repository with per-machine variation, unattended, and can see and recover from every failure. Harness targets match each harness's real discovery model, including the shared `.agents/` location.

## Decisions

- Each machine syncs itself on a timer (launchd or systemd user timer). No central SSH runner; an ad-hoc fan-out script is out of scope.
- Harness `claude-code` is renamed `claude` everywhere: config values, harness-specific source directories, and template filenames. Breaking; no compatibility alias.
- New harness `generic` targets `.agents/`: `~/.agents/skills` globally, `<scope>/AGENTS.md` and `<scope>/.agents/skills` in projects. It emits no global instruction file because no harness reads `~/.agents/AGENTS.md`.
- `codex` targets `~/.codex/AGENTS.md` globally and `<project>/.codex/skills` in projects. It emits no global skills, because Codex marks `$CODEX_HOME/skills` as deprecated; global Codex skills come from `generic`. In projects, Codex-specific instruction snippets render into the shared `<scope>/AGENTS.md` when `codex` is selected.
- Skill placement rule: each skill has exactly one destination root per harness-visible scope. Harness-specific skill content is allowed only when the skill lands in a root read exclusively by that harness. Codex reads `.agents/skills`, so a skill emitted through `generic` must not carry Codex-specific content (lint error). Codex de-duplicates skills by path only, so two same-named skills visible to one harness are a lint error.
- `claude` keeps `~/.claude/` and `<scope>/.claude/`. When a project scope's `CLAUDE.md` would be byte-identical to its `AGENTS.md`, agentsmith writes a `CLAUDE.md` containing only `@AGENTS.md` (on by default, with an opt-out). Claude Code never loads an `@AGENTS.md` import twice under any `instructionFiles` setting. Omitting `CLAUDE.md` was rejected: any `CLAUDE.md` above cwd disables Claude's `AGENTS.md` fallback.
- Profiles and project scopes can enable or disable skills per harness.
- Profiles may `extends` one parent profile: parent packs first, then child packs; skill lists merge; no subtraction.
- Reliability: last-run `status.json`, `asmith global status`, distinct exit codes, `--on-modified=backup`.
- `asmith global adopt` adopts only content strictly prepended or appended to a generated instruction file (`AGENTS.md`, `CLAUDE.md`). It writes a `*.local.md` snippet to `--slot`, or by default to reserved `prepend`/`append` slots added implicitly to every instruction artifact. Skills and any other edit are never adopted; they are backed up and resolved by hand. Requires keeping the last generated content of each global artifact.
- `asmith global init <git-url> --profile <name> [--schedule]` bootstraps a machine; `asmith global schedule install` installs the timer.
- Out of scope: notifications (belong in the scheduler wrapper), central fleet view, multi-user administration.

## Work order

1. **Discovery research** (no code). A reference page per harness: discovered paths, precedence, and whether files concatenate or shadow each other. Feeds slice A. Runs alongside step 2.
2. **Rename `claude-code` to `claude`.** Mechanical, touches most files; lands first so no parallel branch has to absorb it.
3. In parallel worktrees branched from step 2:
   - **A. Harness model**: `generic`, the new `codex` destinations, the placement and duplicate-name lints, per-harness skill enablement, the `CLAUDE.md` de-duplication option, an ADR, and integrating the research page.
   - **B. Reliability**: stored artifact content, `status.json`, `global status`, exit codes, `--on-modified=backup`, `global adopt` with the reserved `prepend`/`append` slots.
   - **C. Profile `extends`**.
4. **D. Bootstrap** after B: `global init`, `global schedule install`.

Each slice ends with `bun run check` and updates the specification, configuration reference, and user documentation it affects.

## Acceptance

- Generated paths match the decisions above in harness and integration tests, including duplicate-name and placement lint errors.
- `claude-code` is rejected everywhere with a clear error.
- An unattended sync over a hand-edited `CLAUDE.md` with `--on-modified=backup` succeeds, keeps a backup, and records a warning in `status.json`.
- `global adopt` round-trips a prepend and an append into snippets that reproduce the edited file on the next generation, and refuses a mid-file edit.
- A fresh machine reaches a synced, scheduled state with `global init --schedule`.

## Slice E: adding snippets from the CLI

`asmith global add <slot> [text]` and `asmith project add <slot> [text]` write a new snippet into a pack slot.

- Content: the trailing positional argument, `--file <path>`, or stdin when neither is given and stdin is not a TTY. Exactly one source.
- Target: `instructions/[<harness>/]<slot>/` by default; `--skill-slot` targets `skill-slots/[harnesses/<harness>/]<slot>/`. `--harness <name>` selects the harness-specific directory.
- Validation: an instruction slot must be declared by the selected template for some harness in scope; a skill slot must be declared by at least one enabled skill. Otherwise exit nonzero and list the slots that exist. For a skill slot, the output lists every skill that will receive the snippet.
- Pack: `--pack` is required unless exactly one candidate exists (the profile's only pack; the scope's only project pack). The same rule applies to `global adopt`.
- Numbering: `--placement gap|first|last`, default `gap`: the file directly after the lower neighbor of the largest gap between existing two-digit prefixes (`00, 10, 11, 99` gives `12`); ties take the lowest gap; an empty slot starts at `50`; no free number is an error, and existing files are never renamed. `first` and `last` go below the lowest and above the highest prefix. Filename `NN-<slug>.md`, slug from the content or `--name`.
- `--local` (global only) writes `*.local.md` and requires Git to ignore it.
- After writing: lint (removing the file and failing on errors), then regenerate this machine's artifacts unless `--skip-generate`.
- A global snippet that is not `--local` is committed by default (only the new file); `--no-commit` opts out. An uncommitted file in the Source Repository blocks every later sync.
- `--push` (global only, not with `--local`): require a clean source, `git pull --ff-only`, write, lint, commit only the new file, push, then regenerate.
- `--dry-run` prints the path and content without writing.

## Slice F: sandbox home, exclusive mode, clean

Three independent features; one worktree, landed in this order.

### F1. `home` in the machine config

- Optional `home = "<path>"`, resolved relative to the machine config file. When set, every agentsmith destination and every piece of agentsmith state (artifacts, `state.json`, `status.json`, blobs, backups, logs) resolves under it instead of `$HOME`. `CODEX_HOME` is ignored while `home` is set, so a sandbox never writes into the real `~/.codex`.
- Git and SSH keep the real `$HOME` (identity, keys, credential helpers), so `global init`, `global add` and syncs against a private remote work from a sandbox.
- `global schedule install` already passes `--config`; a sandboxed config therefore schedules a sandboxed job. The schedule definition itself (LaunchAgent, systemd unit) stays in the real home.
- `global status` and every error that prints a path show the resolved path.

### F2. Exclusive mode and skill adoption

- Opt-in `exclusive = true` in a profile (inherited through `extends`) and in the project config (top level, overridable per `[[scopes]]`).
- `exclusive_allow = ["<glob>", ...]` beside it lists skill names managed by other tools (for example skills installed by `npx skills add`); globs match the skill directory name. Profile lists merge as an ordered union through `extends`.
- With exclusive mode on, every skill directory in a skill root read by a selected harness, in the scope being generated, that agentsmith did not write and that `exclusive_allow` does not match, is an unmanaged skill. Hidden directories (such as Codex's `.system`) are skipped.
- Unmanaged skills fail lint with exit 5 (`artifact-modified` class), listing each path. With `--on-modified=backup` they are moved to the backup root (globally `~/.agents/agentsmith/backups/<ts>/…`; in projects the same layout under the project state directory) and recorded as warnings in `status.json`; the run succeeds.
- `asmith global adopt --skill <name> [--pack <pack>] [--push | --no-commit]` copies an unmanaged global skill into `skills/<name>/` in the Source Repository, appends `<name>` to the pack's `skills`, lints, commits only those changes by default (same rules as `global add`, including `--push` and `--no-commit`), and regenerates, after which the skill is managed. `--pack` follows the single-candidate rule. A name that already exists in the Source Repository is an error. `project adopt --skill` does the same into the project's own source tree and never commits.

### F3. `clean`

- `asmith global clean` and `asmith project clean [--scope]`: dry run by default, printing every path that would be removed; `-y`/`--yes` deletes.
- Removes only artifacts recorded in state whose current content matches the recorded content, then agentsmith's state, status and blobs for that mode. A modified artifact is refused (exit 5) unless `--on-modified=backup` (backed up, then removed) or `--force` (removed).
- Leaves the machine config, the Source Repository clone, backups, logs and the schedule alone (`global schedule uninstall` stays separate). Empty directories that agentsmith created are removed; directories that held other files are kept.
- In a project, removed tracked files show up as Git deletions for the user to commit.

### Acceptance

- A machine config with `home` generates, syncs, reports status and cleans entirely inside the sandbox, while Git operations use the real identity.
- Exclusive mode reports an unmanaged skill, leaves an allowed one alone, quarantines with `--on-modified=backup`, and `global adopt --skill` turns it into a managed skill that regenerates byte-identically.
- `clean` dry-runs, deletes with `-y`, refuses a modified artifact, and a following `generate` recreates the same tree.
- Docs: configuration reference, commands reference, SPEC, troubleshooting, and a guide section for each feature.

## Slice G: shared and personal project layers

### Decisions

- **Inputs, not files, decide what is shared.** A project input is shared when it lives in the project's committed `.config/agentsmith/` tree and is not a `*.local.md` snippet. Everything else is personal: Source Repository skills, packs, templates and partials, and `*.local.md` snippets.
- **Instructions are committed; skills are not.** Every project generation renders two layers:
  - Shared layer, from shared inputs only: `<scope>/AGENTS.md` and `<scope>/CLAUDE.md` (or its `@AGENTS.md` import). Meant to be committed. Adding a personal input never changes it.
  - Personal layer, from all inputs, written only when it differs from the shared layer: `<scope>/AGENTS.override.md` (Codex reads it instead of `AGENTS.md`) and `<scope>/CLAUDE.local.md`, plus an entry for `<scope>/CLAUDE.md` in `claudeMdExcludes` in `<project>/.claude/settings.local.json` (Claude then loads only `CLAUDE.local.md` for that folder, and does not fall back to `AGENTS.md`; verified on Claude Code 2.1.322). agentsmith owns only its own `claudeMdExcludes` entries and preserves every other key. Generic tools see the shared layer.
  - Skills are generated and never committed: shared and personal skills land in the same skill roots.
- **Git ignores.** `project init` adds to `.gitignore`: each skill root with a kept placeholder (`/.claude/skills/*`, `!/.claude/skills/.gitkeep`, the same for `.agents/skills` and `.codex/skills`). Claude Code only reloads skill folders that existed when the session started, so the placeholder lets skills generated mid-session appear on the next turn. Codex picks up a new skill on the next turn even when its folder did not exist at session start (both verified, Claude Code 2.1.322 and Codex via T3). Personal instruction files (`AGENTS.override.md`, `CLAUDE.local.md`) go in `.git/info/exclude`, so the repository never mentions a personal layer.
- **Generation without a Source Repository.** Without a machine config, `project generate` renders what shared inputs define and skips everything personal with a notice instead of failing: Source Repository skills, packs (their instruction and skill-slot snippets), templates and partials. A project skill whose required slot only personal packs fill is skipped with a warning; an empty optional slot renders empty.
- **Ownership of ignored files.** Project state records a content hash for every artifact (global state already does), so a stale or regenerated artifact that Git does not track can still be checked for hand edits before it is replaced or deleted. Removing a personal artifact also removes its `claudeMdExcludes` entry. `.git/info/exclude` entries are only ever added, never removed (see the note below).
- **Name collisions.** A generated skill whose name matches a skill directory agentsmith does not own (committed by the repository's authors, or hand-written) is an error naming that path; rename the skill.
- **Third-party repositories.** `upstream = "keep" | "replace"` (default `keep`) in the project config, or in a profile entry matching the repository path or remote URL when the repository has no agentsmith config of its own. agentsmith never writes the committed files of such a repository.
  - `keep`: `AGENTS.override.md` is the upstream `AGENTS.md` followed by the personal layer; `CLAUDE.local.md` holds only the personal layer, and no `claudeMdExcludes` entry is written.
  - `replace`: both files hold only the personal layer, and the upstream `CLAUDE.md` is excluded. Upstream skills stay visible; generic tools still read the upstream `AGENTS.md`.
- **`project init`.** Writes `.config/agentsmith/config.toml` with harnesses detected from existing `.claude/`, `.codex/` and `.agents/` directories, the ignore entries above, and with `--prepare`:
  - Detects the package manager from the `packageManager` field in `package.json`, then the lockfile in the repository root (`bun.lock`/`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm), falling back to npm. It uses that package manager's command to add `asmith` as a dev dependency and in every command it prints (`bunx`, `pnpm exec`/`pnpm dlx`, `yarn`, `npx`).
  - Sets `scripts.prepare` to `asmith project generate`; npm-compatible scripts resolve the project's installed `asmith`, so the pinned version runs. An existing `prepare` that already runs `asmith project generate` is left as is. Any other existing `prepare` is preserved unchanged, with a warning that prints the chained command to add by hand.
- **No hooks.** agentsmith installs no SessionStart hooks: they would run on every start, resume, compaction and subagent, and neither harness loads instruction files or skills that a hook creates during the same turn. The documentation gives an optional instruction snippet ("if `.agents/skills/` is empty, run `<pm> install`; skills appear from the next turn") and a hook recipe for users who want one.

### Acceptance

- A project with personal inputs produces a committed shared layer that does not change when a personal snippet is added, and personal override files that Codex and Claude load instead of it.
- A fresh clone without a machine config generates the shared layer and shared skills, skipping personal inputs with notices.
- Removing a skill from the configuration deletes its generated, ignored directory on the next generation, and refuses to when it was edited by hand.
- `upstream = keep` and `replace` produce the documented files without modifying any committed upstream file.
- `project init --prepare` picks the right package manager, preserves a foreign `prepare` script with a warning, and is idempotent.

### Notes

- **`.git/info/exclude` is add-only (follow-up).** `info/exclude` is shared by every worktree of a repository, but project state is per worktree. Removing a line when one worktree's personal file goes away could un-ignore the same file in another worktree, so agentsmith only adds lines, in generation and in `clean` alike. They live in one block between `# BEGIN agentsmith: …` and `# END agentsmith`, each line once; a line for a missing file is harmless, and users remove the block by hand.
- **`project init --template NAME` (follow-up).** A project whose template comes from the Source Repository has no committed `AGENTS.md`, since the shared layer reads only project inputs. `--template` copies the template family (every harness variant) and every partial it transitively includes from the Source Repository into `.config/agentsmith/`, rewriting `source:` includes to `project:`, and points scope `.` at `project:NAME`. It never overwrites a differing project file and is idempotent. Without the flag, init prints a hint when the Source Repository has templates.

## Slice H: Antigravity harness and per-harness limits

Two independent parts, built in parallel worktrees and merged into `feat/fleet-readiness`. Antigravity's limit entries were added at the merge.

### H1. `antigravity` harness

Verified against agy 1.5.13 (2026-11-22):

- Instructions are cumulative; nothing overrides or excludes a file. In a project, every `AGENTS.md`, `GEMINI.md` and `.agents/rules/*.md` with `trigger: always_on` front matter from the working directory up to the repository root loads. `AGENTS.override.md`, `CLAUDE.md` and `GEMINI.local.md` are not read. `rules.json` `exclude` does not affect `AGENTS.md`/`GEMINI.md`. Globally, `~/.gemini/GEMINI.md`, `~/.gemini/AGENTS.md`, `~/.gemini/config/GEMINI.md`, `~/.gemini/config/AGENTS.md` and `~/.gemini/config/rules/*.md` all load.
- Skills: project `.agents/skills` and `.agent/skills` (also `_agents`, `_agent`); global `~/.gemini/config/skills` and `~/.gemini/skills`. Not read: `.claude/skills`, `.codex/skills`, `.gemini/skills` in projects, `~/.agents/skills`, `~/.claude/skills`. Same-named skills resolve by priority (one wins); they are not loaded twice. A skill created mid-session is visible on the next turn even if its folder did not exist at session start.

Decisions:

- Harness name `antigravity`.
- Global: instructions in a file agentsmith owns, `~/.gemini/config/rules/agentsmith.md`, with `trigger: always_on` front matter; skills in `~/.gemini/config/skills`. `generic`'s `~/.agents/skills` does not reach Antigravity.
- Project: shares `<scope>/AGENTS.md` with `codex`/`generic`; agentsmith never writes `GEMINI.md` (Antigravity would load both). Skills in `<scope>/.agents/skills`. Antigravity-specific skill content goes to `.agent/skills`, which only Antigravity reads. Settled with agy 1.5.15 (2026-11-22): with the same skill name in `.agent/skills` and `.agents/skills`, only the `.agent/skills` copy is listed and used (5 of 5 runs, either creation order), so a skill consuming Antigravity skill-slot content gets an `.agent/skills` copy that shadows the shared one for Antigravity, without a duplicate-name error. Antigravity-specific instruction snippets never render into the shared `AGENTS.md`. In a project they go to always-on rules only Antigravity reads (`.agents/rules/`): shared ones to a committed `<scope>/.agents/rules/agentsmith.md`, personal ones to the personal rule (changed after the merge; first shipped as a lint error).
- Personal layer: Antigravity has no replacement mechanism, so personal additions go to a git-excluded `<scope>/.agents/rules/agentsmith-personal.md` (`trigger: always_on`), written only when the scope has personal snippets. It opens with one line stating that it extends `AGENTS.md` and takes precedence where they conflict, then lists each personal snippet under its slot's heading in template order. `upstream = replace` cannot hide upstream files from Antigravity; lint says so when `antigravity` is selected.
- Warn when a scope contains both `AGENTS.md` and `GEMINI.md` and `antigravity` is selected.
- Every Slice A–G feature covers the new roots: placement and duplicate-name lint, `harness_skills.antigravity`, exclusive mode, `clean`, sandbox `home`, `project init` detection, `global adopt` (prepend/append on the owned rule file, front matter preserved), status, docs (harness-discovery page section, configuration, commands, SPEC).

### H2. Per-harness limits

Built-in checks for every selected harness, active without configuration, modelling what each harness actually loads:

| Harness | Unit | Limit | Severity |
|---|---|---|---|
| claude | each CLAUDE.md / CLAUDE.local.md | 200 lines (recommended) | notice |
| claude | on-demand files (nested CLAUDE.md, rules) | 40,000 characters | warning (only the start is read) |
| claude | any instruction file | 4 MiB | error (skipped) |
| claude | `@import` chain | depth 4 | error |
| claude | skill `description` + `when_to_use` | 1,536 characters | warning (truncated) |
| claude | all skill listings | ≈1% of a 200K-token context window | warning |
| claude | SKILL.md | 500 lines (recommended) | notice |
| codex | project AGENTS.md chain at a scope (all ancestors, override files counted instead of the file they replace) | 32 KiB | warning (later files skipped) |
| codex | skill `name` | 64 characters | error (skill not loaded) |
| codex | skill `description` | 1,024 characters | warning (truncated) |
| codex | all skill descriptions visible at a scope | 8,000 characters | warning (descriptions dropped) |
| antigravity | each rule file | 24,000 bytes | error (truncated) |
| antigravity | all always-on rules visible at a scope | 20,000 tokens (estimated at 4 bytes/token) | warning (largest demoted to pointers) |

- Token limits are estimates and say so.
- `[budgets]` keeps working and can override any default per harness (e.g. `[budgets.codex] project_doc_bytes = 65536` to match a raised `project_doc_max_bytes`); exact key names are part of the slice.
- Checks run in `lint`, `generate`, `sync` and `add`, at the existing diagnostic severities (`notice` never fails a run).
