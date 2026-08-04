# Design

## Configuration contract

TOML document identity comes from its fixed path and loader, not an embedded version. Each loader retains exact-key validation:

- machine: `source`, `profile`
- source root: optional `budgets`
- profile: `harnesses`, `template`, `packs`, `skills_enable`, `skills_disable`, optional `budgets`
- project: `harnesses`, `scopes`, optional `budgets`
- pack manifest, when present: optional `skills`

`version` becomes an unknown key everywhere.

## Pack loading

Resolve the pack directory first. If `pack.toml` is absent, return `{ skills: [] }`. If present, parse it strictly and normalize missing `skills` to `[]`. Instruction and skill-slot discovery remains directory-based.

## Compatibility

None. Existing configuration containing `version` must be edited. Empty pack manifests are deleted because the directory itself expresses an instruction-only pack.
