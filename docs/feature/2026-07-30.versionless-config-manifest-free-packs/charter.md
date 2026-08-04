# Versionless configuration and manifest-free packs

## Goal

Agent Smith configuration TOML has no schema-version field. A pack directory is valid without `pack.toml`; the manifest exists only to declare auto-enabled skills.

## Scope

- Remove `version` from machine, source-root, profile, project, and pack configuration schemas.
- Reject `version` and every other unsupported key.
- Load missing `pack.toml` as an instruction-only pack with no skills.
- Keep `pack.toml` strict when present; accept only optional `skills`.
- Update tests, fixtures, public docs, examples, and this repository's dogfood inputs.
- Preserve versioned runtime state and package/release versions; they are not configuration.
- No global-file changes, migrations, compatibility paths, commits, or project regeneration.

## Acceptance and verification

- Versionless configuration loads; any `version` key fails: focused config tests.
- Packs without manifests load with `skills: []`: focused config and integration tests.
- Present manifests enable skills and reject unsupported keys: focused config/planner tests.
- Dogfood project lint succeeds without config versions or empty manifest: installed/source CLI lint.
- Documentation contains no configuration `version = 1` examples or claims that manifests are mandatory: repository search and docs checks.
- Repository remains healthy: `bun run check`.

## Execution shape

One breaking-change slice: red tests, implementation, fixture/docs cleanup, full validation, independent review. No commit.
