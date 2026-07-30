---
title: Troubleshooting
description: Resolve common configuration, Git safety, composition, and collision errors.
---

## Project output is dirty

agentsmith will not overwrite a modified, staged, conflicted, untracked, or ignored destination. Review the file and either commit the intended version or move it out of the generated path. There is no project `--force` option.

For a newly generated output, add and commit it before the next generation.

## Global output is unmanaged or changed

Run `asmith global diff`. If you intentionally want agentsmith to adopt or recover the paths, run `asmith global generate --force`. This updates the external hash state after writing.

## Source Repository is not clean

`global sync` rejects tracked, staged, conflicted, and nonignored untracked source changes. Commit, stash, or remove them before syncing. Ignored local source such as `*.local.md` is allowed.

## Git pull cannot fast-forward

`global sync` uses only `git pull --ff-only`. Resolve divergence manually in the Source Repository, then rerun the command. agentsmith will not merge or rebase on your behalf.

## Missing slot contribution

A `required-slot` received no snippet from the selected packs. Add a contribution under the matching pack slot directory, select the intended pack, or change the directive to an optional `slot`.

## Contribution targets an absent slot

A selected pack has content for a slot the template or enabled skill does not declare. This is usually a mismatched template/pack combination or a misspelled slot name.

## Skill name collision

Two skills visible from the same working location share a public name. `asmith project explain` shows generated skill sources. Rename or disable one source, or remove the conflicting unmanaged skill. agentsmith does not silently choose a winner.

## Codex override shadows generated context

Remove or relocate `AGENTS.override.md` at the planned scope before generation. Codex gives that file precedence, so generating `AGENTS.md` there would be misleading.

## Size budget warning

Use `asmith project explain` or `asmith global explain` to inspect artifact and effective-chain sizes. Reduce duplicated material, move reusable workflow detail into an on-demand skill, or intentionally raise the corresponding budget.

## Diagnose without writing

```sh
asmith project lint
asmith project explain --json
asmith project diff
```

These commands are safe to use while investigating because they do not write generated artifacts.
