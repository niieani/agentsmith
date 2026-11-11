#!/usr/bin/env node
import { object, or } from "@optique/core/constructs";
import { optional, withDefault } from "@optique/core/modifiers";
import { argument, command, constant, option } from "@optique/core/primitives";
import { choice, string } from "@optique/core/valueparser";
import { run } from "@optique/run";
import { executeCommand } from "./commands.ts";
import { errorMessage, exitCodeFor } from "./errors.ts";
import { HARNESS_NAMES } from "./types.ts";
import { VERSION } from "./version.ts";

const configOption = optional(option("--config", string({ metavar: "PATH" })));
const projectOption = optional(option("--project", string({ metavar: "PATH" })));
const intervalOption = optional(option("--interval", string({ metavar: "DURATION" })));
const onModifiedOption = withDefault(option("--on-modified", choice(["fail", "backup"] as const)), "fail" as const);

const addOptions = {
  slot: argument(string({ metavar: "SLOT" })),
  text: optional(argument(string({ metavar: "TEXT" }))),
  file: optional(option("--file", string({ metavar: "PATH" }))),
  skillSlot: option("--skill-slot"),
  harness: optional(option("--harness", choice(HARNESS_NAMES))),
  pack: optional(option("--pack", string({ metavar: "NAME" }))),
  placement: withDefault(option("--placement", choice(["gap", "first", "last"] as const)), "gap" as const),
  name: optional(option("--name", string({ metavar: "NAME" }))),
  local: option("--local"),
  push: option("--push"),
  noCommit: option("--no-commit"),
  skipGenerate: option("--skip-generate"),
  dryRun: option("--dry-run"),
};

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
      config: configOption,
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
      skill: optional(option("--skill", string({ metavar: "NAME" }))),
      pack: optional(option("--pack", string({ metavar: "NAME" }))),
      push: option("--push"),
      noCommit: option("--no-commit"),
      dryRun: option("--dry-run"),
    }),
  ),
  command("add", object({ action: constant("add"), config: configOption, ...addOptions })),
  command(
    "init",
    object({
      action: constant("init"),
      url: argument(string({ metavar: "GIT_URL" })),
      profile: option("--profile", string({ metavar: "NAME" })),
      source: optional(option("--source", string({ metavar: "PATH" }))),
      config: configOption,
      schedule: option("--schedule"),
      interval: intervalOption,
      yes: option("--yes"),
    }),
  ),
  command(
    "schedule",
    or(
      command("install", object({ action: constant("schedule-install"), interval: intervalOption, config: configOption })),
      command("uninstall", object({ action: constant("schedule-uninstall") })),
      command("status", object({ action: constant("schedule-status") })),
    ),
  ),
  command(
    "clean",
    object({
      action: constant("clean"),
      config: configOption,
      yes: option("-y", "--yes"),
      force: option("--force"),
      onModified: onModifiedOption,
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
  command("add", object({ action: constant("add"), project: projectOption, scope: optional(option("--scope", string({ metavar: "PATH" }))), ...addOptions })),
  command("generate", object({ action: constant("generate"), project: projectOption, onModified: onModifiedOption })),
  command(
    "adopt",
    object({
      action: constant("adopt"),
      project: projectOption,
      scope: optional(option("--scope", string({ metavar: "PATH" }))),
      skill: option("--skill", string({ metavar: "NAME" })),
      pack: optional(option("--pack", string({ metavar: "NAME" }))),
      dryRun: option("--dry-run"),
    }),
  ),
  command(
    "clean",
    object({
      action: constant("clean"),
      project: projectOption,
      scope: optional(option("--scope", string({ metavar: "PATH" }))),
      yes: option("-y", "--yes"),
      force: option("--force"),
      onModified: onModifiedOption,
    }),
  ),
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
