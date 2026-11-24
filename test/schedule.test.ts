import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, RunCommandOptions } from "../src/git.ts";
import {
  configFromCommand,
  formatInterval,
  installSchedule,
  intervalSeconds,
  LAUNCHD_LABEL,
  printScheduleStatus,
  readInstalledSchedule,
  renderLaunchAgent,
  renderSystemdService,
  renderSystemdTimer,
  resolveSelfInvocation,
  type ScheduledJob,
  type SchedulerHost,
  uninstallSchedule,
} from "../src/schedule.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Call {
  command: string;
  args: readonly string[];
  options?: RunCommandOptions;
}

type Responder = (command: string, args: readonly string[]) => Partial<CommandResult> | undefined;

async function fakeHost(platform: NodeJS.Platform, respond: Responder = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-schedule-"));
  temporary.push(root);
  const home = join(root, "home");
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  const config = join(root, "config.toml");
  await writeFile(config, `source = ${JSON.stringify(source)}\nprofile = "test"\n`);
  const files = new Map<string, string>();
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const host: SchedulerHost = {
    platform,
    home,
    cwd: root,
    uid: 501,
    user: "fixture",
    env: { PATH: "/custom/bin:/usr/bin", SSH_AUTH_SOCK: "/tmp/agent.sock", HOME: home },
    execPath: "/opt/asmith/bin/asmith",
    argv: ["/opt/asmith/bin/asmith", "/$bunfs/root/asmith", "global", "schedule", "install"],
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      const result = { stdout: "", stderr: "", exitCode: 0, ...respond(command, args) };
      if (result.exitCode !== 0 && !options?.allowFailure) throw new Error(`${command} ${args.join(" ")} failed`);
      return result;
    },
    readFile: async (path) => files.get(path),
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    removeFile: async (path) => files.delete(path),
    mkdir: async () => {},
    realpath: (path) => (path.startsWith("/$bunfs/") ? undefined : path),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const commands = () => calls.filter((call) => call.command !== "git").map((call) => [call.command, ...call.args].join(" "));
  return { host, home, source, config, files, calls, commands, out, err };
}

const job = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  programArguments: ["/opt/asmith/bin/asmith", "global", "sync", "--on-modified=backup"],
  environment: { PATH: "/opt/asmith/bin:/usr/bin" },
  intervalSeconds: 3600,
  logDirectory: "/Users/me/.agents/agentsmith/logs",
  devCheckout: false,
  configPath: "/Users/me/.agents/agentsmith/config.toml",
  ...overrides,
});

describe("resolveSelfInvocation", () => {
  const realpath = (path: string) => (path.startsWith("/$bunfs/") ? undefined : path.replace("/bin/asmith", "/lib/node_modules/asmith/dist/npm/asmith.js"));

  test("runs the compiled binary alone", () => {
    expect(resolveSelfInvocation({ execPath: "/usr/local/bin/asmith", argv: ["/usr/local/bin/asmith", "/$bunfs/root/asmith", "global"], realpath })).toEqual({
      argv: ["/usr/local/bin/asmith"],
      devCheckout: false,
    });
  });

  test("runs node with the canonical npm script", () => {
    expect(resolveSelfInvocation({ execPath: "/usr/bin/node", argv: ["/usr/bin/node", "/usr/local/bin/asmith", "global"], realpath })).toEqual({
      argv: ["/usr/bin/node", "/usr/local/lib/node_modules/asmith/dist/npm/asmith.js"],
      devCheckout: false,
    });
  });

  test("flags a development checkout run through bun", () => {
    expect(resolveSelfInvocation({ execPath: "/usr/bin/bun", argv: ["/usr/bin/bun", "/work/agentsmith/src/cli.ts", "global"], realpath })).toEqual({
      argv: ["/usr/bin/bun", "/work/agentsmith/src/cli.ts"],
      devCheckout: true,
    });
  });
});

describe("schedule rendering", () => {
  test("renders a launchd agent", () => {
    const plist = renderLaunchAgent(job({ programArguments: ["/opt/a&b/asmith", "global", "sync", "--on-modified=backup"], intervalSeconds: 1800 }));
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    // The job overwrites one log per run instead of letting launchd append forever.
    expect(plist).toContain(
      "<string>/bin/sh</string>\n\t\t<string>-c</string>\n\t\t<string>exec &apos;/opt/a&amp;b/asmith&apos; global sync --on-modified=backup &gt;/Users/me/.agents/agentsmith/logs/last-run.log 2&gt;&amp;1</string>",
    );
    expect(plist).not.toContain("StandardOutPath");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>1800</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(plist).toContain("<key>PATH</key>\n\t\t<string>/opt/asmith/bin:/usr/bin</string>");
  });

  test("renders systemd user units", () => {
    const scheduled = job({ programArguments: ["/home/me/my tools/asmith", "global", "sync", "--on-modified=backup", "--config", "/home/me/50%.toml"] });
    const service = renderSystemdService(scheduled);
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("Environment=PATH=/opt/asmith/bin:/usr/bin");
    expect(service).toContain('ExecStart="/home/me/my tools/asmith" global sync --on-modified=backup --config /home/me/50%%.toml');
    const timer = renderSystemdTimer(scheduled);
    expect(timer).toContain("OnBootSec=2min");
    expect(timer).toContain("OnUnitActiveSec=3600s");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=agentsmith-sync.service");
    expect(timer).toContain("WantedBy=timers.target");
  });

  test("parses and formats intervals", () => {
    expect(intervalSeconds()).toBe(3600);
    expect(intervalSeconds("1h30m")).toBe(5400);
    expect(() => intervalSeconds("30s")).toThrow("at least 1m");
    expect(() => intervalSeconds("soon")).toThrow("Invalid duration");
    expect(formatInterval(5400)).toBe("1h30m");
    expect(formatInterval(86_400)).toBe("1d");
  });
});

describe("macOS schedule", () => {
  test("installs, replacing a loaded agent, and warns when Git needs an agent", async () => {
    const fixture = await fakeHost("darwin", (command, args) => {
      if (command === "git" && args[0] === "ls-remote") return { exitCode: 128, stderr: "git@github.com: Permission denied (publickey)." };
      if (command === "git") return { exitCode: 1 };
      return undefined;
    });
    await installSchedule({ config: fixture.config, interval: "30m" }, fixture.host);
    const plistPath = join(fixture.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    expect(fixture.commands()).toEqual([
      `launchctl print gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootout gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootstrap gui/501 ${plistPath}`,
    ]);
    const plist = fixture.files.get(plistPath)!;
    expect(plist).toContain("<integer>1800</integer>");
    expect(plist).toContain(
      `<string>exec /opt/asmith/bin/asmith global sync --on-modified=backup --config ${fixture.config} &gt;${fixture.home}/.agents/agentsmith/logs/last-run.log 2&gt;&amp;1</string>`,
    );
    // schedule status shows the asmith command, not the logging shell around it.
    expect((await readInstalledSchedule(fixture.host)).command).toBe(`/opt/asmith/bin/asmith global sync --on-modified=backup --config ${fixture.config}`);
    expect(plist).toContain("<string>/opt/asmith/bin:/custom/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>");

    const probe = fixture.calls.find((call) => call.command === "git" && call.args[0] === "ls-remote")!;
    expect(probe.options?.cwd).toBe(fixture.source);
    expect(probe.options?.env?.SSH_AUTH_SOCK).toBeUndefined();
    expect(probe.options?.env?.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
    expect(probe.options?.env?.PATH).toContain("/opt/homebrew/bin");
    expect(fixture.err.join("\n")).toContain("deploy key");
    expect(fixture.out.join("\n")).toContain("Every 30m: /opt/asmith/bin/asmith global sync --on-modified=backup --config");

    const status = await readInstalledSchedule(fixture.host);
    expect(status).toMatchObject({ installed: true, active: true, intervalSeconds: 1800 });
    expect(status.command).toBe(`/opt/asmith/bin/asmith global sync --on-modified=backup --config ${fixture.config}`);
  });

  test("skips bootout when not loaded and reports no warning when Git is reachable", async () => {
    const fixture = await fakeHost("darwin", (command, args) => {
      if (command === "launchctl" && args[0] === "print") return { exitCode: 113 };
      if (command === "git" && args[0] === "config") return { exitCode: 1 };
      return undefined;
    });
    await installSchedule({ config: fixture.config }, fixture.host);
    expect(fixture.commands()).toEqual([
      `launchctl print gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootstrap gui/501 ${join(fixture.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)}`,
    ]);
    expect(fixture.err).toEqual([]);
  });

  test("uninstalls and reports status", async () => {
    let loaded = true;
    const fixture = await fakeHost("darwin", (command, args) => {
      if (command === "launchctl" && args[0] === "print") return { exitCode: loaded ? 0 : 113 };
      if (command === "launchctl" && args[0] === "bootout") loaded = false;
      if (command === "launchctl" && args[0] === "bootstrap") loaded = true;
      return undefined;
    });
    await installSchedule({ config: fixture.config }, fixture.host);
    fixture.calls.length = 0;
    await uninstallSchedule(fixture.host);
    expect(fixture.commands()).toEqual([`launchctl print gui/501/${LAUNCHD_LABEL}`, `launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
    expect(fixture.files.size).toBe(0);
    fixture.out.length = 0;
    await printScheduleStatus(fixture.host);
    expect(fixture.out).toEqual(["Schedule: not installed (run `asmith global schedule install`).", "Last run: none recorded"]);
  });

  test("warns when scheduling a development checkout", async () => {
    const fixture = await fakeHost("darwin");
    fixture.host.execPath = "/usr/bin/bun";
    fixture.host.argv = ["/usr/bin/bun", "/work/agentsmith/src/cli.ts", "global"];
    await installSchedule({ config: fixture.config }, fixture.host);
    expect(fixture.err.join("\n")).toContain("development checkout (/work/agentsmith/src/cli.ts)");
  });
});

describe("Linux schedule", () => {
  test("installs systemd user units and mentions lingering", async () => {
    const fixture = await fakeHost("linux", (command) => (command === "loginctl" ? { stdout: "no\n" } : command === "git" ? { exitCode: 1 } : undefined));
    await installSchedule({ config: fixture.config, interval: "2h" }, fixture.host);
    const units = join(fixture.home, ".config", "systemd", "user");
    expect(fixture.commands()).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now agentsmith-sync.timer",
      "loginctl show-user fixture --property=Linger --value",
    ]);
    expect(fixture.files.get(join(units, "agentsmith-sync.timer"))).toContain("OnUnitActiveSec=7200s");
    expect(fixture.files.get(join(units, "agentsmith-sync.service"))).toContain(
      `ExecStart=/opt/asmith/bin/asmith global sync --on-modified=backup --config ${fixture.config}`,
    );
    expect(fixture.out.join("\n")).toContain("loginctl enable-linger fixture");

    fixture.calls.length = 0;
    await uninstallSchedule(fixture.host);
    expect(fixture.commands()).toEqual(["systemctl --user disable --now agentsmith-sync.timer", "systemctl --user daemon-reload"]);
    expect(fixture.files.size).toBe(0);
  });

  test("omits the lingering note when lingering is on", async () => {
    const fixture = await fakeHost("linux", (command) => (command === "loginctl" ? { stdout: "yes\n" } : undefined));
    await installSchedule({ config: fixture.config }, fixture.host);
    expect(fixture.out.join("\n")).not.toContain("enable-linger");
  });
});

describe("sandboxed machine config", () => {
  test("logs under the sandbox home while the job definition stays in the real home", async () => {
    const fixture = await fakeHost("darwin");
    const sandbox = join(fixture.host.cwd, "sandbox");
    await mkdir(join(sandbox, "home"), { recursive: true });
    const config = join(sandbox, "config.toml");
    await writeFile(config, `source = ${JSON.stringify(fixture.source)}\nprofile = "test"\nhome = "home"\n`);
    await installSchedule({ config }, fixture.host);
    const plist = fixture.files.get(join(fixture.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`));
    expect(plist).toContain(`--config ${config} &gt;${join(sandbox, "home", ".agents", "agentsmith", "logs", "last-run.log")}`);

    await mkdir(join(sandbox, "home", ".agents", "agentsmith"), { recursive: true });
    await writeFile(
      join(sandbox, "home", ".agents", "agentsmith", "status.json"),
      JSON.stringify({ version: 1, command: "sync", outcome: "success", timestamp: "2026-11-10T12:00:00.000Z", exitCode: 0 }),
    );
    fixture.out.length = 0;
    await printScheduleStatus(fixture.host);
    expect(fixture.out.at(-1)).toBe("Last run: global sync succeeded at 2026-11-10T12:00:00.000Z");
  });

  test("reads --config from rendered commands", () => {
    expect(configFromCommand("/bin/asmith global sync --on-modified=backup --config /a/config.toml")).toBe("/a/config.toml");
    expect(configFromCommand("asmith global sync --config '/a b/it'\\''s.toml'")).toBe("/a b/it's.toml");
    expect(configFromCommand('asmith global sync --config "/a b/c%%d.toml"')).toBe("/a b/c%d.toml");
    expect(configFromCommand("asmith global sync --on-modified=backup")).toBeUndefined();
  });
});

test("rejects unsupported platforms and missing machine config", async () => {
  const fixture = await fakeHost("win32");
  await expect(installSchedule({ config: fixture.config }, fixture.host)).rejects.toThrow("not on win32");
  await expect(uninstallSchedule(fixture.host)).rejects.toThrow("not on win32");
  const mac = await fakeHost("darwin");
  await expect(installSchedule({ config: join(mac.home, "missing.toml") }, mac.host)).rejects.toMatchObject({ code: "config" });
  expect(mac.calls).toEqual([]);
});
