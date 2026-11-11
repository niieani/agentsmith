import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { loadMachineConfig } from "./config.ts";
import { AgentsmithError, classify, errorMessage } from "./errors.ts";
import { type CommandResult, type RunCommandOptions, runCommand } from "./git.ts";
import { globalStatusPath, parseDuration, readGlobalStatus } from "./status.ts";

export const LAUNCHD_LABEL = "io.github.niieani.agentsmith.sync";
export const SYSTEMD_SERVICE = "agentsmith-sync.service";
export const SYSTEMD_TIMER = "agentsmith-sync.timer";
export const DEFAULT_INTERVAL = "1h";
const MINIMUM_INTERVAL_SECONDS = 60;
const GIT_PROBE_TIMEOUT_MS = 30_000;

/**
 * Every side effect the scheduler commands need from the operating system, so
 * tests can verify generated files and invoked commands without touching the
 * real launchd or systemd.
 */
export interface SchedulerHost {
  platform: NodeJS.Platform;
  home: string;
  cwd: string;
  uid: number;
  user: string;
  env: NodeJS.ProcessEnv;
  /** `process.execPath` of the running asmith. */
  execPath: string;
  /** `process.argv` of the running asmith. */
  argv: readonly string[];
  run(command: string, args: readonly string[], options?: RunCommandOptions): Promise<CommandResult>;
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** The canonical path of an existing file, or undefined when it does not exist. */
  realpath(path: string): string | undefined;
  out(line: string): void;
  err(line: string): void;
}

export function systemSchedulerHost(): SchedulerHost {
  return {
    platform: process.platform,
    home: homedir(),
    cwd: process.cwd(),
    uid: process.getuid?.() ?? 0,
    user: userInfo().username,
    env: process.env,
    execPath: process.execPath,
    argv: process.argv,
    run: (command, args, options) => runCommand(command, args, options),
    readFile: async (path) => (existsSync(path) ? readFile(path, "utf8") : undefined),
    writeFile: (path, content) => writeFile(path, content, { mode: 0o644 }),
    removeFile: async (path) => {
      if (!existsSync(path)) return false;
      await rm(path, { force: true });
      return true;
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return undefined;
      }
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

export interface SelfInvocation {
  /** The command and leading arguments that run this asmith. */
  argv: string[];
  /** Whether the invocation runs TypeScript sources from a development checkout. */
  devCheckout: boolean;
}

/**
 * How to run the current asmith again from a scheduler: the compiled binary
 * alone, or the runtime plus the script it executes (the npm build under Node,
 * or `src/cli.ts` under Bun).
 */
export function resolveSelfInvocation(host: Pick<SchedulerHost, "execPath" | "argv" | "realpath">): SelfInvocation {
  const script = host.argv[1];
  const embedded = script === undefined || script.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(script);
  const scriptPath = embedded || !isAbsolute(script) ? undefined : host.realpath(script);
  if (scriptPath === undefined) return { argv: [host.execPath], devCheckout: false };
  return { argv: [host.execPath, scriptPath], devCheckout: /\.[cm]?tsx?$/.test(scriptPath) };
}

export interface ScheduleOptions {
  interval?: string;
  config?: string;
}

export interface ScheduledJob {
  programArguments: string[];
  environment: Record<string, string>;
  intervalSeconds: number;
  logDirectory: string;
  devCheckout: boolean;
  /** Absolute machine config path, passed to the job only when explicitly chosen. */
  configPath: string;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function machineConfigPathFor(host: Pick<SchedulerHost, "home" | "cwd">, config?: string): string {
  return config === undefined ? join(host.home, ".agents", "agentsmith", "config.toml") : resolve(host.cwd, expandHome(config, host.home));
}

/** A PATH for the job: launchd and systemd start jobs with a minimal one in which `git` may be missing. */
export function scheduledPath(host: Pick<SchedulerHost, "env" | "execPath">): string {
  const entries = [
    dirname(host.execPath),
    ...(host.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(entries.filter((entry) => entry !== "" && isAbsolute(entry)))].join(delimiter);
}

export function intervalSeconds(interval = DEFAULT_INTERVAL): number {
  const seconds = Math.round(parseDuration(interval) / 1000);
  if (seconds < MINIMUM_INTERVAL_SECONDS) throw new AgentsmithError("config", `Schedule interval must be at least 1m: ${JSON.stringify(interval)}`);
  return seconds;
}

export function formatInterval(seconds: number): string {
  const units: Array<[string, number]> = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ];
  let rest = seconds;
  let text = "";
  for (const [unit, size] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) text += `${count}${unit}`;
    rest -= count * size;
  }
  return text || "0s";
}

export function scheduledJob(host: SchedulerHost, options: ScheduleOptions): ScheduledJob {
  const invocation = resolveSelfInvocation(host);
  const configPath = machineConfigPathFor(host, options.config);
  const environment: Record<string, string> = { PATH: scheduledPath(host) };
  if (host.env.CODEX_HOME) environment.CODEX_HOME = host.env.CODEX_HOME;
  return {
    programArguments: [...invocation.argv, "global", "sync", "--on-modified=backup", ...(options.config === undefined ? [] : ["--config", configPath])],
    environment,
    intervalSeconds: intervalSeconds(options.interval),
    logDirectory: join(host.home, ".agents", "agentsmith", "logs"),
    devCheckout: invocation.devCheckout,
    configPath,
  };
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function unxml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

export function launchAgentPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** The single log a scheduled macOS run overwrites; `status.json` keeps the outcome, so older output is not kept. */
export function launchAgentLogPath(job: Pick<ScheduledJob, "logDirectory">): string {
  return join(job.logDirectory, "last-run.log");
}

/**
 * launchd only appends to StandardOutPath, so logs would grow forever. The job runs through `/bin/sh -c` with a
 * truncating redirect instead, keeping only the most recent run's output.
 */
export function launchAgentArguments(job: ScheduledJob): string[] {
  return ["/bin/sh", "-c", `exec ${shellCommand(job.programArguments)} >${shellWord(launchAgentLogPath(job))} 2>&1`];
}

/** The asmith command inside a rendered launchd job, unwrapping the logging shell. */
function unwrapLaunchAgentCommand(args: string[]): string {
  if (args.length === 3 && args[0] === "/bin/sh" && args[1] === "-c") {
    return args[2]!
      .replace(/^exec /, "")
      .replace(/ >(?:'[^']*'|\S+) 2>&1$/, "")
      .trimEnd();
  }
  return shellCommand(args);
}

export function renderLaunchAgent(job: ScheduledJob): string {
  const strings = (values: string[]) => values.map((value) => `\t\t<string>${xml(value)}</string>`).join("\n");
  const environment = Object.entries(job.environment)
    .map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings(launchAgentArguments(job))}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${environment}
\t</dict>
\t<key>StartInterval</key>
\t<integer>${job.intervalSeconds}</integer>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>ProcessType</key>
\t<string>Background</string>
</dict>
</plist>
`;
}

export function systemdUnitDirectory(host: Pick<SchedulerHost, "home" | "env">): string {
  const configHome = host.env.XDG_CONFIG_HOME && isAbsolute(host.env.XDG_CONFIG_HOME) ? host.env.XDG_CONFIG_HOME : join(host.home, ".config");
  return join(configHome, "systemd", "user");
}

/** Quote one word for a systemd `ExecStart=` or `Environment=` line. */
function systemdWord(value: string): string {
  const escaped = value.replaceAll("%", "%%").replaceAll("$", "$$$$");
  if (/^[A-Za-z0-9_\-./:=@+,%]+$/.test(escaped)) return escaped;
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderSystemdService(job: ScheduledJob): string {
  const environment = Object.entries(job.environment).map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`)}`);
  return `[Unit]
Description=agentsmith global sync

[Service]
Type=oneshot
${environment.join("\n")}
ExecStart=${job.programArguments.map(systemdWord).join(" ")}
`;
}

export function renderSystemdTimer(job: ScheduledJob): string {
  return `[Unit]
Description=Run agentsmith global sync every ${formatInterval(job.intervalSeconds)}

[Timer]
OnBootSec=2min
OnUnitActiveSec=${job.intervalSeconds}s
Persistent=true
Unit=${SYSTEMD_SERVICE}

[Install]
WantedBy=timers.target
`;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_\-./:=@+,%]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function shellCommand(argv: readonly string[]): string {
  return argv.map(shellWord).join(" ");
}

function unsupported(platform: string): never {
  throw new AgentsmithError("failure", `Scheduling is supported on macOS (launchd) and Linux (systemd user timers), not on ${platform}`);
}

/**
 * Check that the Source Repository's remote is reachable the way the scheduler
 * will reach it: no SSH agent, no terminal prompts, the baked-in PATH. Returns
 * a warning, never fails.
 */
async function probeGitAccess(host: SchedulerHost, job: ScheduledJob): Promise<string | undefined> {
  let source: string;
  try {
    source = loadMachineConfig(job.configPath).source;
  } catch (cause) {
    return `WARNING schedule-git-access: could not check Source Repository access: ${errorMessage(cause)}`;
  }
  const env: NodeJS.ProcessEnv = { ...host.env, PATH: job.environment.PATH };
  for (const key of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_ASKPASS", "GIT_ASKPASS", "DISPLAY"]) delete env[key];
  if (!env.GIT_SSH_COMMAND) {
    const configured = await host.run("git", ["config", "--get", "core.sshCommand"], { cwd: source, env, allowFailure: true }).catch(() => undefined);
    if (!configured?.stdout.trim()) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  }
  const result = await host
    .run("git", ["ls-remote", "--quiet", "--exit-code"], { cwd: source, env, allowFailure: true, timeoutMs: GIT_PROBE_TIMEOUT_MS })
    .catch((cause: unknown) => ({ stdout: "", stderr: errorMessage(cause), exitCode: 1 }));
  if (result.exitCode === 0) return undefined;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.exitCode}`;
  return [
    `WARNING schedule-git-access: the scheduled job may not be able to fetch the Source Repository (${source}).`,
    `  git ls-remote without an SSH agent or credential prompts failed: ${detail}`,
    "  Scheduled jobs have no SSH agent and cannot prompt. Give this machine non-interactive read access,",
    "  for example a read-only deploy key without a passphrase (configured in ~/.ssh/config or core.sshCommand)",
    "  or an HTTPS token stored in a Git credential helper.",
  ].join("\n");
}

async function launchdLoaded(host: SchedulerHost): Promise<boolean> {
  const result = await host.run("launchctl", ["print", `gui/${host.uid}/${LAUNCHD_LABEL}`], { allowFailure: true });
  return result.exitCode === 0;
}

export async function installSchedule(options: ScheduleOptions, host: SchedulerHost = systemSchedulerHost()): Promise<void> {
  if (host.platform !== "darwin" && host.platform !== "linux") unsupported(host.platform);
  const job = scheduledJob(host, options);
  await classify("config", () => loadMachineConfig(job.configPath));
  if (job.devCheckout) {
    host.err(
      `WARNING schedule-dev-checkout: scheduling a development checkout (${job.programArguments[1]}); the job breaks if this checkout moves or changes.`,
    );
  }
  await host.mkdir(job.logDirectory);
  if (host.platform === "darwin") {
    const plist = launchAgentPath(host.home);
    await host.mkdir(dirname(plist));
    await host.writeFile(plist, renderLaunchAgent(job));
    const domain = `gui/${host.uid}`;
    if (await launchdLoaded(host)) await host.run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { allowFailure: true });
    await host.run("launchctl", ["bootstrap", domain, plist]);
    host.out(`Installed LaunchAgent ${plist}`);
    host.out(`Log (latest run only): ${launchAgentLogPath(job)}`);
  } else {
    const directory = systemdUnitDirectory(host);
    await host.mkdir(directory);
    await host.writeFile(join(directory, SYSTEMD_SERVICE), renderSystemdService(job));
    await host.writeFile(join(directory, SYSTEMD_TIMER), renderSystemdTimer(job));
    await host.run("systemctl", ["--user", "daemon-reload"]);
    await host.run("systemctl", ["--user", "enable", "--now", SYSTEMD_TIMER]);
    host.out(`Installed systemd user units ${join(directory, SYSTEMD_SERVICE)} and ${SYSTEMD_TIMER}`);
    host.out(`Logs: journalctl --user -u ${SYSTEMD_SERVICE}`);
    const linger = await host.run("loginctl", ["show-user", host.user, "--property=Linger", "--value"], { allowFailure: true }).catch(() => undefined);
    if (linger?.stdout.trim() !== "yes") {
      host.out(`Note: lingering is off for ${host.user}; the timer runs only while you are logged in.`);
      host.out(`  On an always-on host, run: loginctl enable-linger ${host.user}`);
    }
  }
  host.out(`Every ${formatInterval(job.intervalSeconds)}: ${shellCommand(job.programArguments)}`);
  const warning = await probeGitAccess(host, job);
  if (warning) host.err(warning);
}

export async function uninstallSchedule(host: SchedulerHost = systemSchedulerHost()): Promise<void> {
  if (host.platform === "darwin") {
    const plist = launchAgentPath(host.home);
    const loaded = await launchdLoaded(host);
    if (loaded) await host.run("launchctl", ["bootout", `gui/${host.uid}/${LAUNCHD_LABEL}`]);
    const removed = await host.removeFile(plist);
    host.out(loaded || removed ? `Removed LaunchAgent ${LAUNCHD_LABEL}.` : "No schedule is installed.");
    return;
  }
  if (host.platform === "linux") {
    const directory = systemdUnitDirectory(host);
    const timer = join(directory, SYSTEMD_TIMER);
    if ((await host.readFile(timer)) !== undefined) await host.run("systemctl", ["--user", "disable", "--now", SYSTEMD_TIMER], { allowFailure: true });
    const removedTimer = await host.removeFile(timer);
    const removedService = await host.removeFile(join(directory, SYSTEMD_SERVICE));
    if (!removedTimer && !removedService) {
      host.out("No schedule is installed.");
      return;
    }
    await host.run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
    host.out(`Removed systemd user units ${SYSTEMD_SERVICE} and ${SYSTEMD_TIMER}.`);
    return;
  }
  unsupported(host.platform);
}

export interface InstalledSchedule {
  installed: boolean;
  /** Whether launchd has the job loaded, or the systemd timer is active. */
  active?: boolean;
  definition?: string;
  intervalSeconds?: number;
  command?: string;
}

export async function readInstalledSchedule(host: SchedulerHost): Promise<InstalledSchedule> {
  if (host.platform === "darwin") {
    const plist = launchAgentPath(host.home);
    const content = await host.readFile(plist);
    if (content === undefined) return { installed: false };
    const interval = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(content)?.[1];
    const argsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)?.[1] ?? "";
    const args = [...argsBlock.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1]!));
    return {
      installed: true,
      active: await launchdLoaded(host),
      definition: plist,
      intervalSeconds: interval === undefined ? undefined : Number(interval),
      command: args.length > 0 ? unwrapLaunchAgentCommand(args) : undefined,
    };
  }
  if (host.platform === "linux") {
    const directory = systemdUnitDirectory(host);
    const timer = await host.readFile(join(directory, SYSTEMD_TIMER));
    const service = await host.readFile(join(directory, SYSTEMD_SERVICE));
    if (timer === undefined && service === undefined) return { installed: false };
    const interval = /^OnUnitActiveSec=(\d+)s$/m.exec(timer ?? "")?.[1];
    const active = await host.run("systemctl", ["--user", "is-active", SYSTEMD_TIMER], { allowFailure: true }).catch(() => undefined);
    return {
      installed: true,
      active: active?.stdout.trim() === "active",
      definition: join(directory, SYSTEMD_TIMER),
      intervalSeconds: interval === undefined ? undefined : Number(interval),
      command: /^ExecStart=(.*)$/m.exec(service ?? "")?.[1],
    };
  }
  unsupported(host.platform);
}

export async function printScheduleStatus(host: SchedulerHost = systemSchedulerHost()): Promise<number> {
  const schedule = await readInstalledSchedule(host);
  if (!schedule.installed) {
    host.out("Schedule: not installed (run `asmith global schedule install`).");
  } else {
    const state = host.platform === "darwin" ? (schedule.active ? "loaded" : "not loaded") : schedule.active ? "active" : "inactive";
    host.out(`Schedule: installed (${state})`);
    host.out(`Definition: ${schedule.definition}`);
    host.out(`Interval: ${schedule.intervalSeconds === undefined ? "(unknown)" : formatInterval(schedule.intervalSeconds)}`);
    host.out(`Command: ${schedule.command ?? "(unknown)"}`);
  }
  const statusPath = globalStatusPath(join(host.home, ".agents", "agentsmith", "state.toml"));
  try {
    const status = await readGlobalStatus(statusPath);
    host.out(
      status === undefined
        ? "Last run: none recorded"
        : `Last run: global ${status.command} ${status.outcome === "success" ? "succeeded" : `failed (exit ${status.exitCode})`} at ${status.timestamp}`,
    );
  } catch (cause) {
    host.out(`Last run: ${errorMessage(cause)}`);
  }
  return 0;
}
