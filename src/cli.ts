#!/usr/bin/env node
import { object, or } from "@optique/core/constructs";
import { optional, withDefault } from "@optique/core/modifiers";
import { command, constant, option } from "@optique/core/primitives";
import { choice, string } from "@optique/core/valueparser";
import { run } from "@optique/run";
import { executeCommand } from "./commands.ts";
import { errorMessage, exitCodeFor } from "./errors.ts";
import { VERSION } from "./version.ts";

const configOption = optional(option("--config", string({ metavar: "PATH" })));
const projectOption = optional(option("--project", string({ metavar: "PATH" })));
const onModifiedOption = withDefault(option("--on-modified", choice(["fail", "backup"] as const)), "fail" as const);

const globalCommands = or(
  command(
    "sync",
    object({
      action: constant("sync"),
      config: configOption,
      force: option("--force"),
      onModified: onModifiedOption,
    }),
  ),
  command(
    "generate",
    object({
      action: constant("generate"),
      config: configOption,
      force: option("--force"),
      onModified: onModifiedOption,
    }),
  ),
  command(
    "status",
    object({
      action: constant("status"),
      json: option("--json"),
      maxAge: optional(option("--max-age", string({ metavar: "DURATION" }))),
    }),
  ),
  command(
    "adopt",
    object({
      action: constant("adopt"),
      config: configOption,
      slot: optional(option("--slot", string({ metavar: "NAME" }))),
      pack: optional(option("--pack", string({ metavar: "NAME" }))),
      dryRun: option("--dry-run"),
    }),
  ),
  command("diff", object({ action: constant("diff"), config: configOption })),
  command(
    "lint",
    object({
      action: constant("lint"),
      config: configOption,
      warningsAsErrors: option("--warnings-as-errors"),
    }),
  ),
  command(
    "explain",
    object({
      action: constant("explain"),
      config: configOption,
      json: option("--json"),
    }),
  ),
);

const projectCommands = or(
  command("generate", object({ action: constant("generate"), project: projectOption })),
  command("diff", object({ action: constant("diff"), project: projectOption })),
  command(
    "lint",
    object({
      action: constant("lint"),
      project: projectOption,
      warningsAsErrors: option("--warnings-as-errors"),
    }),
  ),
  command(
    "explain",
    object({
      action: constant("explain"),
      project: projectOption,
      json: option("--json"),
    }),
  ),
);

const parser = or(
  command("global", object({ mode: constant("global"), command: globalCommands })),
  command("project", object({ mode: constant("project"), command: projectCommands })),
);

const parsed = run(parser, {
  programName: "asmith",
  help: "both",
  version: VERSION,
  completion: "both",
  errorExitCode: 2,
});

try {
  process.exitCode = await executeCommand(parsed.mode, parsed.command.action, parsed.command);
} catch (cause) {
  console.error(errorMessage(cause));
  process.exitCode = exitCodeFor(cause);
}
