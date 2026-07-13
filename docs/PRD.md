# agentsmith product requirements

## Summary

agentsmith is a personal, Git-backed command-line tool that assembles agent instruction files and Agent Skills for multiple machines, projects, project subtrees, and agent harnesses. It turns reusable Markdown sources into the native files that Codex and Claude Code discover.

The CLI is named `asmith`. The canonical project spelling is lowercase `agentsmith`.

## Motivation

Agent configuration is spread across long-lived laptops, workstations, servers, and virtual machines. Some guidance should be shared everywhere; other guidance belongs only to a machine role, project, language, framework, issue tracker, harness, or monorepo subtree. Native instruction inheritance solves where files apply, but it does not synchronize machines, inject reusable content into precise document sections, compose skills, or explain how an artifact was assembled.

Existing synchronization tools tend to copy or symlink a single source of truth. Existing multi-harness generators do not fully address all of these needs together:

- Git-backed synchronization across machines that may run continuously;
- profile-based machine selection without hard-coded hostname conditions;
- slot-based Markdown composition instead of broad concatenation;
- additive reusable packs for orthogonal concerns such as Bun, Go, iOS, GitHub, Jira, or server operation;
- distinct templates for materially different project shapes;
- repository and subtree scopes aligned with real harness discovery;
- build-time composition of skills and partials into self-contained artifacts;
- safe, reviewable, deterministic generation with lint, diff, and provenance.

agentsmith exists to provide that complete workflow while keeping its source model small enough to understand by inspecting the filesystem.

## Goals

1. Synchronize a reusable Source Repository and generate personal artifacts for an active machine profile.
2. Generate project-owned artifacts without performing project-side synchronization.
3. Support Codex and Claude Code through validated, explicit harness adapters.
4. Model global, repository, and subtree scopes according to native instruction and skill discovery.
5. Compose instructions and skills from template families, additive ordered packs, slots, snippets, and partials.
6. Make every planned artifact explainable and previewable before it is written.
7. Refuse destructive overwrites and remove only stale artifacts previously owned by agentsmith.
8. Detect ambiguous visible skills, lost pack contributions, invalid directives, unsafe paths, and excessive output size.
9. Produce deterministic, self-contained artifacts with no runtime agentsmith dependency.

## Non-goals for v1

- A daemon, login hook, scheduler, or automatic background synchronization.
- Project-side `git pull` or any implicit project network operation.
- Arbitrary custom harness definitions or configurable raw destination paths.
- Symlink-based deployment.
- Native MDX or a general-purpose templating language.
- YAML metadata for snippets, partial shapes, ordering, or applicability.
- Boolean pack conditions, pack dependencies, conflicts, or suppressing packs.
- Runtime skill chaining or runtime partial includes.
- Skill version resolution as a separate package-management concept.
- Website implementation, package publication, release automation, or multi-user administration.

## Users and scenarios

### Multiple machines

A laptop profile selects `base`, `personal`, and `macos`. A studio profile adds `server`. A Linux VM selects `base` and `server`. `asmith global sync` fast-forwards the shared Source Repository and regenerates every harness configured by the active profile.

### Precise instruction composition

A template defines Git, tooling, testing, and communication sections. Packs contribute numbered snippets into the relevant slots. Machine- and harness-specific content lands inside the correct section rather than being appended as a broad layer.

### Mixed project concerns

A Bun project selects `bun` and `github`; a Go service selects `go` and `jira`; a data-science repository selects a different template family while reusing the same issue-tracker pack. No single project-type hierarchy controls these orthogonal choices.

### Monorepo scopes

A repository scope provides shared instructions and skills. `apps/ios` introduces only iOS-specific artifacts, while `services/api` introduces service-specific artifacts. Broader artifacts remain inherited and are not copied into narrower scopes.

### Composed skills

An issue-tracker pack enables `to-issues` and fills its tracker-specific slots. A complex grilling skill includes shared private partials at generation time. The emitted skill is flat and self-contained; the harness does not need to invoke or load implementation-building-block skills at runtime.

### Local machine source

A Git-ignored `50-studio.local.md` snippet contributes a machine-only note. It participates in rendering without making the Source Repository dirty or blocking synchronization.

## Functional requirements

### Global operations

`asmith global sync` must:

1. load the machine configuration and active profile;
2. verify that the Source Repository is a clean Git worktree, allowing ignored local source;
3. run noninteractive `git pull --ff-only` against the current upstream;
4. plan and validate all global artifacts for all configured harnesses;
5. preflight ownership and local-edit safety;
6. apply the complete plan or write nothing.

`global generate`, `diff`, `lint`, and `explain` perform no pull and require no remote.

### Project operations

`asmith project generate` discovers project configuration from the requested project path or its ancestors. It renders all declared scopes and harnesses but never pulls the project or Source Repository.

Project generation requires Git for path-specific overwrite safety. Lint, diff, and explain may run without Git when no write is requested, with reduced collision reporting stated clearly when machine-global configuration is unavailable.

### Scopes and inheritance

- A project declares a repository scope and any number of subtree scopes.
- Each Scope Pack Selection contains only packs introduced at that scope.
- A scope may have an Instruction Layer, introduce skills, or both.
- Scope paths determine ancestry; configuration does not repeat broader packs.
- The effective context at a working location is formed by native harness inheritance.
- A visible public skill name may appear only once on any effective scope chain.

### Harnesses

v1 supports:

- Codex: global `AGENTS.md`, scoped `AGENTS.md`, global Agent Skills, and scoped `.agents/skills`;
- Claude Code: global `CLAUDE.md`, scoped `CLAUDE.md`, global Claude skills, and scoped `.claude/skills`.

Adapters own native paths, discovery rules, instruction shadowing checks, and skill-root behavior. The composition engine remains harness-neutral.

### Source ownership

- The machine configuration selects one Source Repository and active profile.
- The Source Repository owns reusable profiles, template families, packs, skills, and partials.
- A project owns its configuration and may mirror templates, packs, skills, and partials under its agentsmith configuration directory.
- Unqualified Source IDs resolve only in the Source Repository.
- `@project/...` Source IDs resolve only in the current project.
- Source qualification never changes a skill's public name.

### Composition

- Template families provide a template for each harness and may provide a common fallback.
- Templates and skill Markdown accept line-only HTML-comment directives.
- Includes resolve before slots.
- Slots receive snippets in selected-pack order, then deterministic filename order.
- Common snippets precede the same pack's harness-specific snippets.
- Optional empty slots disappear; required empty slots fail.
- Selected contributions may never disappear silently because a template or skill lacks their slot.
- Every Markdown file in a skill source is rendered; non-Markdown support files are copied byte-for-byte with executable bits preserved.
- Output Markdown uses LF and exactly one terminal newline.

### Skill selection

- Packs auto-enable skills explicitly listed by their manifest.
- A scope may explicitly enable additional skills or exclude skills it would otherwise introduce.
- Repeated enablement of the same Source ID is idempotent.
- Multiple packs may contribute to one enabled skill.
- Exclusion is scope-local and cannot hide an inherited skill.
- Stale skills previously generated by agentsmith must be safely removed when no longer enabled.

### Inspection

- `lint` reports configuration, discovery, source, directive, composition, collision, and budget problems without writing.
- `diff` renders proposed artifacts and stale deletions as unified diffs without writing, regardless of output cleanliness.
- `explain` reports scope, harness, destination, template, ordered packs, snippets, includes, skill enablement/exclusion, sizes, and provenance. `--json` emits stable machine-readable output.

### Safety

- The complete Generation Plan is rendered, linted, and preflighted before any write.
- Project generation may replace only tracked-clean destinations. Dirty, staged, conflicted, untracked, or ignored existing destinations fail the whole operation.
- Project generation has no force bypass.
- Global generation may replace only files matching agentsmith's recorded state. Initial adoption or explicit recovery requires `--force`.
- No ownership marker or hash is inserted into an artifact.
- Stale artifacts are deleted only when recorded as agentsmith-owned and still clean.
- Writes are atomic per artifact, and a failed application restores the previous set.
- Source symlinks and paths escaping their declared roots are rejected.

## Quality requirements

- Deterministic results across repeated runs on the same inputs.
- Strict, versioned TOML; unknown keys are errors.
- Clear diagnostics containing the responsible source and destination paths.
- No partial output after validation or preflight failure.
- Unit coverage for parsing, rendering, planning, and safety rules.
- End-to-end coverage in throwaway Git repositories for the CLI workflows.

## Acceptance criteria

1. Ordered pack snippets render into the exact named template slots for both built-in harnesses.
2. A project with root, iOS, and API scopes generates native instruction and skill artifacts without duplicating broader pack content.
3. A static skill passes through unchanged apart from Markdown normalization; a composed skill resolves includes and slots into a self-contained directory.
4. Missing includes, include cycles, path traversal, malformed directives, missing required slots, and lost selected contributions fail before writes.
5. Headed partials rebase beneath the nearest parent heading; invalid heading structure fails deterministically.
6. Duplicate visible skill names fail, including identical generated copies; unmanaged duplicates are surfaced according to the specification.
7. A dirty tracked project artifact blocks all writes, while `diff` still previews the proposed replacement.
8. Removing a skill from configuration plans a safe deletion only for a previously recorded artifact.
9. Global sync rejects dirty source state and non-fast-forward pulls, then generates every configured harness on success.
10. Local ignored Markdown sources participate in rendering without blocking global sync.
11. Explain output accounts for every selected contribution and generated destination.
12. Repeated generation with unchanged inputs produces no diff.

## Success measure

agentsmith succeeds when one reviewed Source Repository and small per-machine/per-project TOML files can reproducibly create the agent context that would otherwise require manually maintaining many global, repository, subtree, and skill files across machines.
