---
title: Install agentsmith
description: Build the asmith command from source and make it available on your PATH.
---

agentsmith currently requires [Bun](https://bun.sh/) 1.3 or newer and Git.

## Build from source

```sh
git clone <agentsmith-repository-url>
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

## Run without installing

During development, invoke the TypeScript entry point directly:

```sh
bun run src/cli.ts --help
```

The documentation uses `asmith` in examples; substitute `bun run src/cli.ts` when running from source.

## Shell completions

The CLI exposes completion through Optique. Run `asmith --help` for the completion command supported by your current shell.
