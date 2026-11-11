---
title: Command reference
description: Every asmith command, option, and intended workflow.
---

## Global commands

| Command | Purpose |
| --- | --- |
| `asmith global init GIT_URL --profile NAME [--source PATH] [--config PATH] [--schedule] [--interval DURATION] [--yes]` | Bootstrap a machine: clone, select a profile, lint, preview, run the first sync, optionally schedule. |
| `asmith global schedule install [--interval DURATION] [--config PATH]` | Run `global sync --on-modified=backup` on a timer (launchd or systemd user timer). |
| `asmith global schedule uninstall` | Remove the timer. |
| `asmith global schedule status` | Show whether the timer is installed, its interval and command, and the last run. |
| `asmith global sync [--config PATH] [--force] [--on-modified fail\|backup]` | Require clean source, run `git pull --ff-only`, then generate. |
| `asmith global generate [--config PATH] [--force] [--on-modified fail\|backup]` | Generate from the current local source without pulling. |
| `asmith global diff [--config PATH]` | Show prospective writes and stale deletions. |
| `asmith global lint [--config PATH] [--warnings-as-errors]` | Validate without writing. |
| `asmith global explain [--config PATH] [--json]` | Show artifacts, provenance, sizes, slots, and includes. |
| `asmith global status [--json] [--max-age DURATION]` | Show the last recorded `sync` or `generate` run; exit nonzero when it failed or is too old. |
| `asmith global adopt [--config PATH] [--slot NAME] [--pack NAME] [--dry-run]` | Move edits made before or after generated instruction content into local snippets. |
| `asmith global add SLOT [TEXT] [--file PATH] [--skill-slot] [--harness NAME] [--pack NAME] [--placement gap\|first\|last] [--name NAME] [--local] [--push] [--skip-generate] [--dry-run] [--config PATH]` | Write a new snippet into a pack slot, lint, and regenerate. |

The default machine config is `~/.agents/agentsmith/config.toml`.

### Bootstrapping a machine

```sh
asmith global init git@github.com:me/agent-context.git --profile laptop --schedule
```

`global init`:

1. Clones the repository to `--source` (default `~/.agents/agentsmith/source`). If that directory already holds a clone of the same repository, it is reused; a different repository, or a nonempty directory that is not a Git worktree, is an error. Git never prompts.
2. Checks that the profile exists and resolves, including `extends`. If not, it lists the available profiles and exits 2.
3. Writes the machine config. An existing config that selects a different source or profile is replaced only with `--yes`.
4. Lints, then lists every file the first sync would create, update, or replace.
5. Asks before replacing global files agentsmith did not write, such as a hand-written `~/.claude/CLAUDE.md`. It shows the diff and asks in a terminal. With `--yes` it proceeds and keeps a backup (`--on-modified=backup`). Without a terminal and without `--yes`, it exits 5 and prints the command to rerun.
6. Runs the first `global sync`, which records `status.json`.
7. With `--schedule`, installs the timer as `global schedule install` does. `--interval` applies only with `--schedule`.

Rerunning the same `global init` is safe: it reuses the clone and config and syncs again.

### Scheduled sync

`asmith global schedule install` installs a per-user timer that runs:

```sh
<this asmith> global sync --on-modified=backup [--config PATH]
```

`--interval` defaults to `1h` and uses the same duration syntax as `global status --max-age` (minimum `1m`). The job uses the absolute path of the `asmith` you ran: the compiled binary, Node plus the npm script, or Bun plus `src/cli.ts`; agentsmith warns when you schedule a development checkout. The job's `PATH` is captured at install time, so `git` is found even though schedulers start with a minimal `PATH`.

| Platform | Files | Logs |
| --- | --- | --- |
| macOS | `~/Library/LaunchAgents/io.github.niieani.agentsmith.sync.plist` (`StartInterval`, `RunAtLoad`), loaded with `launchctl bootstrap gui/<uid>` | `~/.agents/agentsmith/logs/sync.out.log`, `sync.err.log` |
| Linux | `~/.config/systemd/user/agentsmith-sync.service` and `.timer`, enabled with `systemctl --user enable --now` | `journalctl --user -u agentsmith-sync.service` |

On Linux, user timers run only while you have a login session unless lingering is on. Install tells you when to run `loginctl enable-linger $USER`, which an always-on host needs.

The scheduled job has no SSH agent and cannot answer credential prompts. Install checks this by running `git ls-remote` the same way and warns if it fails; the install itself still succeeds. Give each machine non-interactive read access: a read-only deploy key without a passphrase, or an HTTPS token in a Git credential helper.

`asmith global schedule status` prints whether the timer is installed and loaded, its interval and command, and the last recorded run. Use `asmith global status --max-age 3h` for monitoring.

### Modified global artifacts

`--on-modified` decides what `global sync` and `global generate` do with a global artifact whose content differs from what agentsmith last generated, or that exists without being recorded:

- `fail` (default) stops the run with exit code 5 and changes nothing.
- `backup` renames the artifact to `<name>.agentsmith-<UTC timestamp>`, for example `CLAUDE.md.agentsmith-20261110T120000Z`, then generates. A changed file inside a skill moves the whole skill directory to `~/.agents/agentsmith/backups/<UTC timestamp>/<original path>`, outside every skill folder. Each backup is printed as a `WARNING artifact-backup` line on stderr and recorded in `status.json`. The run still exits 0.

`--force` keeps its meaning: in `fail` mode it overwrites unrecorded or modified artifacts without a backup. With `backup`, `--force` has no further effect.

### Run status

Every `global sync` and `global generate` writes `~/.agents/agentsmith/status.json`, whether it succeeds or fails:

```json
{
  "version": 1,
  "command": "sync",
  "startedAt": "2026-11-10T12:00:00.000Z",
  "timestamp": "2026-11-10T12:00:01.204Z",
  "profile": "studio",
  "sourceCommit": "3d49d90…",
  "outcome": "success",
  "exitCode": 0,
  "error": null,
  "warnings": ["WARNING artifact-backup: moved modified global artifact …"],
  "backups": [{ "path": "/home/me/.claude/CLAUDE.md", "backup": "/home/me/.claude/CLAUDE.md.agentsmith-20261110T120000Z", "reason": "modified" }]
}
```

`timestamp` is when the run finished. `sourceCommit` is the Source Repository `HEAD` after any pull, or `null` when unknown. On failure, `error` holds the error `code` (see the table below) and message.

`asmith global status` prints that record. `--json` prints it with `ageSeconds`, `stale`, and `healthy` added. `--max-age` accepts durations such as `90s`, `30m`, `6h`, `1d`, `1w`, or `1h30m`. The command exits with the failed run's own exit code when the last run failed, with 6 when no run is recorded or the last one is older than `--max-age`, and 0 otherwise.

### Adopting local edits

`asmith global adopt` handles global `AGENTS.md` and `CLAUDE.md` files edited by hand. For each one, it compares the file to the content agentsmith last generated. When the file is exactly *added text + generated content + added text*, it writes the added text as snippets in the Source Repository and regenerates:

- The text before goes to `packs/<pack>/instructions/<harness>/prepend/00-adopted.local.md`.
- The text after goes to `packs/<pack>/instructions/<harness>/append/99-adopted.local.md`.
- With `--slot NAME`, both parts go to `packs/<pack>/instructions/<harness>/<NAME>/99-adopted.local.md`. The slot must exist in the template.

`--pack` must be one of the profile's packs and is required unless the profile selects exactly one pack. Repeated adoptions add to the same snippet files: newer prepended text goes before older text, and newer appended text goes after it. `--dry-run` reports what would be adopted and writes nothing.

Adoption refuses, changes nothing, and exits nonzero when:

- an edit is not strictly before or after the generated content (exit 5),
- a modified artifact is a skill file (exit 5). Skills are never adopted,
- no stored generated content exists for the artifact, for example because it was last generated by an older agentsmith (exit 5),
- a snippet path would not be ignored by Git in the Source Repository, since the new file would block `global sync` (exit 2). Ignore `*.local.md` in the Source Repository's `.gitignore`.

### Adding snippets

`asmith global add SLOT [TEXT]` and `asmith project add SLOT [TEXT]` write a new snippet into a pack slot, check it, and regenerate:

```sh
asmith global add tools "Use Bun for scripts and tests."
asmith global add verification --file notes/verify.md --harness codex
pbpaste | asmith global add review --skill-slot --name review-checklist
asmith project add tools "Run make check before pushing." --pack local
```

- **Content** comes from `TEXT`, from `--file PATH`, or from standard input when neither is given and standard input is not a terminal. Pass exactly one. Line endings are normalized and a final newline is added.
- **Target**: `packs/<pack>/instructions/[<harness>/]<SLOT>/` by default; with `--skill-slot`, `packs/<pack>/skill-slots/[harnesses/<harness>/]<SLOT>/`. `--harness NAME` writes the harness-specific directory and must name a harness the profile or scope selects. Project add writes to `.config/agentsmith/packs/<pack>/`.
- **Validation**: an instruction slot must be declared by the template selected for the profile or scope. The reserved `prepend` and `append` slots always exist. Without `--harness`, the snippet reaches every Instruction Layer of the scope, so each must declare the slot; when only some do, the error names the `--harness` to pass. A skill slot must be declared by at least one enabled skill, and the output lists every skill that will receive the snippet. With `--skill-slot --harness NAME`, only skills placed in a skill root read by that harness alone receive it. Unknown slots exit 2 and list the slots that exist.
- **Pack**: `--pack` is required unless exactly one candidate exists. For `global add`, the candidates are the active profile's packs; for `project add`, the project-owned packs selected by the scope.
- **Scope** (`project add` only): `--scope PATH` names a declared scope by its configured path. The default is the deepest scope containing the current directory, else `.`.
- **Numbering**: the file is named `NN-<slug>.md`. `--placement gap` (default) takes the number directly after the lower neighbor of the largest gap between existing two-digit prefixes: `00, 10, 11, 99` gives `12`. The free run above the highest prefix, up to 99, counts as a gap, so a slot holding only `10` gives `11`. Ties take the lowest gap. `--placement first` takes the number directly below the lowest prefix, `last` directly above the highest. An empty slot starts at `50`. Entries without a two-digit `NN-` prefix are ignored. Existing files are never renamed, so a slot with no free number in the requested place is an error. The slug comes from `--name` or from the first line of text in the content: lowercase ASCII words joined by hyphens, at most six words and 48 characters.
- `--local` (global only) writes `NN-<slug>.local.md` and requires Git to ignore it in the Source Repository.
- After writing, add rebuilds the plan and lints it. If lint fails, or the new snippet renders into no artifact, the file is removed and the command exits 2. Then it regenerates this machine's artifacts as `global generate` does, recording `status.json`, or as `project generate` does. `--skip-generate` skips regeneration. Project regeneration keeps its Git safety rules: when it refuses, for example because generated outputs are uncommitted, the snippet is kept and the error says so.
- `--push` (global only, not with `--local`) requires a clean Source Repository (exit 3), runs `git pull --ff-only` (exit 4), writes and lints, commits only the new file, pushes, and then regenerates. When the push fails, the commit stays in place and the error says how to push it; history is never reset.
- `--dry-run` prints the path, chosen number, and content without writing, pulling, or regenerating.

A global snippet added without `--local` or `--push` is an untracked file in the Source Repository: commit it before the next `global sync`, which rejects nonignored untracked changes.

## Project commands

| Command | Purpose |
| --- | --- |
| `asmith project generate [--project PATH]` | Safely generate project artifacts. |
| `asmith project diff [--project PATH]` | Show prospective project changes without writing. |
| `asmith project lint [--project PATH] [--warnings-as-errors]` | Validate project composition. |
| `asmith project explain [--project PATH] [--json]` | Explain the project plan and provenance. |
| `asmith project add SLOT [TEXT] [--project PATH] [--scope PATH] [--file PATH] [--skill-slot] [--harness NAME] [--pack NAME] [--placement gap\|first\|last] [--name NAME] [--skip-generate] [--dry-run]` | Write a new snippet into a project pack slot, lint, and regenerate. See [adding snippets](#adding-snippets). |

Starting from `--project` or the current directory, agentsmith searches ancestors for `.config/agentsmith/config.toml`.

## Exit behavior

| Exit code | Error code | Meaning |
| --- | --- | --- |
| 0 | | Success, including success with warnings or backups. |
| 1 | `failure` | Any other failure, such as a failed write or a project destination Git does not consider clean. |
| 2 | `config` | Configuration, usage, or validation error, including `lint --warnings-as-errors` with warnings. |
| 3 | `source-dirty` | `global sync` or `global add --push` found tracked, staged, conflicted, or nonignored untracked changes in the Source Repository. |
| 4 | `source-pull` | `git pull --ff-only` (`global sync`, `global add --push`) or the `global init` clone failed: no upstream, authentication, network, or a branch that cannot fast-forward. |
| 5 | `artifact-modified` | A global artifact was modified or unrecorded, `global adopt` refused an edit, or `global init` needs confirmation to replace existing files. |
| 6 | `status-stale` | `global status` found no recorded run, or one older than `--max-age`. |

Warnings succeed unless `--warnings-as-errors` is set.

`diff`, `lint`, and `explain` do not write generated artifacts. Project commands never pull Git.
