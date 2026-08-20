---
title: Install agentsmith
description: Install the asmith command from npm, Homebrew, a release archive, or source.
---

## npm

With Node 24 or newer installed:

```sh
npm install --global asmith
asmith --version
```

### Run without installing globally

Use any common package runner:

```sh
npx asmith@latest --version
bunx asmith@latest --version
pnpx asmith@latest --version
```

Replace `--version` with any command, such as `global lint` or `project diff`.

## Homebrew

On Apple Silicon macOS, install the signed and notarized release:

```sh
brew install --cask niieani/tap/agentsmith
asmith --version
```

## Release archives

The [GitHub Releases page](https://github.com/niieani/agentsmith/releases) provides macOS ARM64, Linux x64, and Linux ARM64 archives plus `checksums.txt`.

Verify a downloaded archive before installing:

```sh
shasum -a 256 -c checksums.txt
tar -xzf agentsmith_*_linux_arm64.tar.gz
install -m 755 asmith ~/.local/bin/asmith
asmith --version
```

## Build from source

Building and testing from source requires [Bun](https://bun.sh/) 1.3 or newer, Node 24 or newer, and Git.

```sh
git clone https://github.com/niieani/agentsmith.git
cd agentsmith
bun install
bun run check
bun run build
```

The compiled executable is written to `dist/asmith`. Copy or symlink it into a directory on your `PATH`:

```sh
ln -s "$PWD/dist/asmith" ~/.local/bin/asmith
asmith --version
```

Choose another user-owned binary directory if `~/.local/bin` is not on your `PATH`.

## Run from source

During development, invoke the TypeScript entry point directly:

```sh
node src/cli.ts --help
bun run src/cli.ts --help
```

The documentation uses `asmith` in examples; substitute either source command when running from the repository.

## Shell completions

The CLI exposes completion through Optique. Run `asmith --help` for the completion command supported by your current shell.
