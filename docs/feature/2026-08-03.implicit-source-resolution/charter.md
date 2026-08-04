# Implicit source resolution

## Goal

Agent Smith configurations use concise source names. Singular sources resolve project-first with Source Repository fallback; packs compose every matching source in deterministic Source Repository then project order. Explicit ownership remains available through `source:` and `project:` qualifiers.

## Scope

- Replace `@project/...` syntax with optional `source:` and `project:` qualifiers; no compatibility path.
- Apply singular resolution to templates, skills, and partials.
- Apply additive multi-source resolution to packs.
- Require at least one matching source; reject duplicate resolved pack sources.
- Surface resolved pack ownership, paths, and order in explanations.
- Record the decision in an ADR and align domain language, tests, fixtures, dogfood inputs, specification, and user documentation.
- Preserve the prior versionless configuration and optional-manifest changes already in the worktree.
- No global-file changes, migrations, branch changes, commits, or unrelated fixes.

## Acceptance and verification

- Unqualified singular sources prefer project and fall back to Source Repository: source/planner tests.
- Unqualified packs compose Source Repository then project contributions and skill enablements: planner and CLI integration tests.
- `source:` and `project:` restrict lookup; missing selected sources hard-fail: config/source tests.
- `@project/...`, unknown qualifiers, malformed names, and duplicate resolved pack selections fail: focused tests.
- Human and JSON explanations identify every resolved pack source and path: command/integration tests.
- Dogfood configuration uses unqualified names and renders no change: source CLI lint/explain/diff.
- Docs and glossary match the ADR: strict docs checks and repository search.
- Repository remains healthy: canonical-temp `bun run check`.

## Execution shape

One breaking-change slice: ADR/design, red tests, source-resolution module refactor, fixture/docs migration, independent contract and cleanup reviews. No commit.
