#!/usr/bin/env bun
import { object, or } from "@optique/core/constructs";
import { optional } from "@optique/core/modifiers";
import { command, constant, option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { run } from "@optique/run";
import { executeCommand } from "./commands.ts";

const configOption = optional(option("--config", string({ metavar: "PATH" })));
const projectOption = optional(option("--project", string({ metavar: "PATH" })));

const globalCommands = or(
  command("sync", object({
    action: constant("sync"),
    config: configOption,
    force: option("--force"),
  })),
  command("generate", object({
    action: constant("generate"),
    config: configOption,
    force: option("--force"),
  })),
  command("diff", object({ action: constant("diff"), config: configOption })),
  command("lint", object({
    action: constant("lint"),
    config: configOption,
    warningsAsErrors: option("--warnings-as-errors"),
  })),
  command("explain", object({
    action: constant("explain"),
    config: configOption,
    json: option("--json"),
  })),
);

const projectCommands = or(
  command("generate", object({ action: constant("generate"), project: projectOption })),
  command("diff", object({ action: constant("diff"), project: projectOption })),
  command("lint", object({
    action: constant("lint"),
    project: projectOption,
    warningsAsErrors: option("--warnings-as-errors"),
  })),
  command("explain", object({
    action: constant("explain"),
    project: projectOption,
    json: option("--json"),
  })),
);

const parser = or(
  command("global", object({ mode: constant("global"), command: globalCommands })),
  command("project", object({ mode: constant("project"), command: projectCommands })),
);

const parsed = run(parser, {
  programName: "asmith",
  help: "both",
  version: "0.1.0",
  completion: "both",
});

try {
  await executeCommand(parsed.mode, parsed.command.action, parsed.command);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
