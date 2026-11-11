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
