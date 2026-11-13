# agentsmith

agentsmith assembles agent instructions and skills from Git-backed templates and reusable packs. It generates native, scope-aware artifacts for Codex, Claude Code, and the shared `.agents/` convention while protecting local edits.

The command is `asmith`.

## What it does

- synchronizes one reusable Source Repository across machines;
- selects machine behavior through profiles and ordered packs;
- generates `AGENTS.md`, `CLAUDE.md`, and native skill directories, placing each skill so no harness sees it twice;
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

Bootstrap a machine from your Source Repository in one command:

```sh
asmith global init git@github.com:me/agent-context.git --profile laptop --schedule
```

This clones the repository to `~/.agents/agentsmith/source`, writes the machine config, lints, shows what it will write, runs the first sync, and installs a launchd agent (macOS) or systemd user timer (Linux) that runs `asmith global sync --on-modified=backup` every hour. If a global file such as `~/.claude/CLAUDE.md` already exists, `init` asks before replacing it (a backup is kept); pass `--yes` to accept without a prompt. Manage the timer with `asmith global schedule install|uninstall|status`. Scheduled syncs cannot use an SSH agent, so give each machine a read-only deploy key or an HTTPS token.

To set up by hand instead, create `~/.agents/agentsmith/config.toml`:

```toml
source = "~/.agents/agentsmith/source"
profile = "laptop"
```

The selected Source Repository contains `agentsmith.toml`, profiles, template families, packs, skills, and partials. A minimal profile looks like:

```toml
harnesses = ["generic", "codex", "claude"]
template = "personal"
packs = ["base", "macos"]
```

`generic` writes `~/.agents/skills` and project `.agents/skills`, which Codex also reads; `codex` writes `~/.codex/AGENTS.md`; `claude` writes `~/.claude/`. See [harness discovery](website/docs/reference/harness-discovery.md) for the full mapping.

Then preview and generate:

```sh
asmith global lint
asmith global diff
asmith global sync
```

`global sync` requires a clean Source Repository and performs `git pull --ff-only` before generation.

## Project setup

Run `asmith project init --prepare` in the repository, or create `.config/agentsmith/config.toml` in the project root:

```toml
harnesses = ["generic", "codex", "claude"]

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

Project generation never pulls Git. Inputs in `.config/agentsmith/` render the committed `AGENTS.md` and `CLAUDE.md`; Source Repository inputs and `*.local.md` snippets render personal `AGENTS.override.md` and `CLAUDE.local.md` files that Git never sees. Skills are generated, not committed. agentsmith replaces an existing output only when Git has it tracked and clean or it still holds what agentsmith last wrote.

## Composition syntax

Directives are standalone HTML-comment lines:

```md
<!-- agentsmith:slot tools -->
<!-- agentsmith:required-slot verification -->
<!-- agentsmith:include grilling/core.md -->
```

The renderer resolves includes, injects selected pack snippets, normalizes Markdown, and emits self-contained artifacts with no agentsmith runtime dependency.
