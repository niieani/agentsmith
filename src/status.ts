import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentsmithError, EXIT_CODES } from "./errors.ts";
import { atomicWrite, globalStatePath, type ArtifactBackup } from "./safety.ts";

/** Facts collected while a global run progresses, recorded even when it fails. */
export interface RunReport {
  warnings: string[];
  backups: ArtifactBackup[];
  profile?: string;
  sourceCommit?: string;
}

export interface GlobalRunStatus {
  version: 1;
  command: "sync" | "generate";
  startedAt: string;
  timestamp: string;
  profile: string | null;
  sourceCommit: string | null;
  outcome: "success" | "failure";
  exitCode: number;
  error: { code: string; message: string } | null;
  warnings: string[];
  backups: Array<{ path: string; backup: string; reason: string }>;
}

export function globalStatusPath(statePath = globalStatePath()): string {
  return join(dirname(statePath), "status.json");
}

export async function writeGlobalStatus(status: GlobalRunStatus, path = globalStatusPath()): Promise<void> {
  await atomicWrite(path, new TextEncoder().encode(`${JSON.stringify(status, null, 2)}\n`));
}

export async function readGlobalStatus(path = globalStatusPath()): Promise<GlobalRunStatus | undefined> {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`Invalid run status: ${path}`, { cause });
  }
  const status = value as Partial<GlobalRunStatus>;
  if (
    status === null ||
    typeof status !== "object" ||
    status.version !== 1 ||
    (status.outcome !== "success" && status.outcome !== "failure") ||
    typeof status.timestamp !== "string" ||
    Number.isNaN(Date.parse(status.timestamp)) ||
    typeof status.exitCode !== "number"
  ) {
    throw new Error(`Invalid run status: ${path}`);
  }
  return status as GlobalRunStatus;
}

const DURATION_UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parse `90s`, `30m`, `2h`, `1d`, `1w`, or combinations such as `1h30m`, into milliseconds. */
export function parseDuration(value: string): number {
  const trimmed = value.trim();
  if (!/^(?:\d+(?:\.\d+)?[smhdw])+$/.test(trimmed)) {
    throw new AgentsmithError("config", `Invalid duration ${JSON.stringify(value)}; use forms such as 90s, 30m, 2h, 1d, or 1h30m`);
  }
  let total = 0;
  for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)([smhdw])/g)) total += Number(match[1]) * DURATION_UNITS[match[2]!]!;
  if (total <= 0) throw new AgentsmithError("config", `Duration must be positive: ${JSON.stringify(value)}`);
  return total;
}

function formatAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Print the last recorded global run and return the exit code a monitor should
 * see: the failed run's own exit code, `status-stale` when too old or absent,
 * otherwise 0.
 */
export async function printGlobalStatus(options: { json?: boolean; maxAge?: string }, now = new Date()): Promise<number> {
  const maxAge = options.maxAge === undefined ? undefined : parseDuration(options.maxAge);
  const path = globalStatusPath();
  const status = await readGlobalStatus(path);
  if (!status) {
    if (options.json) process.stdout.write(`${JSON.stringify({ path, recorded: false, healthy: false }, null, 2)}\n`);
    console.error(`No global run has been recorded yet (${path}).`);
    return EXIT_CODES["status-stale"];
  }
  const ageMs = now.getTime() - Date.parse(status.timestamp);
  const stale = maxAge !== undefined && ageMs > maxAge;
  const failed = status.outcome === "failure";
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ path, recorded: true, ...status, ageSeconds: Math.round(ageMs / 1000), stale, healthy: !failed && !stale }, null, 2)}\n`,
    );
  } else {
    const lines = [
      `Last run: global ${status.command} ${failed ? "failed" : "succeeded"} at ${status.timestamp} (${formatAge(ageMs)} ago)`,
      `Profile: ${status.profile ?? "(unknown)"}`,
      `Source commit: ${status.sourceCommit ?? "(unknown)"}`,
    ];
    if (status.error) lines.push(`Error (${status.error.code}, exit ${status.exitCode}): ${status.error.message}`);
    if (status.backups.length > 0) {
      lines.push("Backups:");
      for (const backup of status.backups) lines.push(`  ${backup.path} -> ${backup.backup}`);
    }
    if (status.warnings.length > 0) {
      lines.push(`Warnings (${status.warnings.length}):`);
      for (const warning of status.warnings) lines.push(`  ${warning}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (failed) {
    console.error(`The last global ${status.command} failed.`);
    return status.exitCode > 0 ? status.exitCode : EXIT_CODES.failure;
  }
  if (stale) {
    console.error(`The last global run is older than ${options.maxAge}.`);
    return EXIT_CODES["status-stale"];
  }
  return 0;
}
