# agentsmith

agentsmith assembles agent instructions and skills from Git-backed templates and reusable packs. It generates native, scope-aware artifacts for Codex and Claude Code while protecting local edits.

The command is `asmith`.

## What it does

- synchronizes one reusable Source Repository across machines;
- selects machine behavior through profiles and ordered packs;
- generates `AGENTS.md`, `CLAUDE.md`, and native skill directories;
- supports repository and monorepo subtree scopes;
- fills precise Markdown slots and flattens reusable partials;
- previews diffs, validates composition, and explains provenance;
- refuses to overwrite dirty project artifacts or modified global artifacts.

See the [end-user documentation](website/docs/index.mdx), [product requirements](docs/PRD.md), [v1 specification](docs/SPEC.md), and [domain language](CONTEXT.md).

## Development

Requirements: Bun 1.3 and Node 24 or newer.

```sh
bun install
bun run check
bun run build
```

## Install

Install from npm with Node 24 or newer:

```sh
npm install --global asmith
```

Or run it without installing globally using your package manager:

```sh
npx asmith@latest --version
bunx asmith@latest --version
pnpx asmith@latest --version
```

Install the signed and notarized macOS ARM64 release with Homebrew:

```sh
brew install --cask niieani/tap/agentsmith
```

Linux ARM64 and x64 archives, macOS ARM64 archives, and checksums are published on the
[GitHub Releases page](https://github.com/niieani/agentsmith/releases).

Run the documentation site:

```sh
bun run docs:dev
```

Run from source:

```sh
node src/cli.ts --help
bun run src/cli.ts --help
```

## Machine setup

Create `~/.agents/agentsmith/config.toml`:

```toml
source = "~/.agents/agentsmith/source"
profile = "laptop"
```

The selected Source Repository contains `agentsmith.toml`, profiles, template families, packs, skills, and partials. A minimal profile looks like:

```toml
harnesses = ["codex", "claude-code"]
template = "personal"
packs = ["base", "macos"]
```

Then preview and generate:

```sh
asmith global lint
asmith global diff
asmith global sync
```

`global sync` requires a clean Source Repository and performs `git pull --ff-only` before generation.

## Project setup

Create `.config/agentsmith/config.toml` in the project root:

```toml
harnesses = ["codex", "claude-code"]

[[scopes]]
path = "."
template = "software"
packs = ["base", "bun", "github"]

[[scopes]]
path = "apps/ios"
template = "ios"
packs = ["swift", "ios"]
```

Generate with:

```sh
asmith project lint
asmith project diff
asmith project generate
```

Project generation never pulls Git. Existing outputs must be tracked and clean; newly generated outputs should be reviewed and committed before the next generation.

## Composition syntax

Directives are standalone HTML-comment lines:

```md
<!-- agentsmith:slot tools -->
<!-- agentsmith:required-slot verification -->
<!-- agentsmith:include grilling/core.md -->
```

The renderer resolves includes, injects selected pack snippets, normalizes Markdown, and emits self-contained artifacts with no agentsmith runtime dependency.
