import { resolve, relative, sep } from "node:path";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly command: readonly string[],
    readonly result: CommandResult,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; allowFailure?: boolean } = {},
): Promise<CommandResult> {
  const process = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const result = { stdout, stderr, exitCode };
  if (exitCode !== 0 && !options.allowFailure) {
    const detail = stderr.trim() || stdout.trim() || `exit status ${exitCode}`;
    throw new CommandError(`${command} ${args.join(" ")} failed: ${detail}`, [command, ...args], result);
  }
  return result;
}

export interface GitWorktree {
  root: string;
  gitDir: string;
}

export async function gitWorktree(path: string): Promise<GitWorktree> {
  const rootResult = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: path });
  const gitDirResult = await runCommand("git", ["rev-parse", "--absolute-git-dir"], { cwd: path });
  return {
    root: resolve(rootResult.stdout.trim()),
    gitDir: resolve(gitDirResult.stdout.trim()),
  };
}

export type GitPathStatus =
  | "missing"
  | "tracked-clean"
  | "modified"
  | "staged"
  | "conflicted"
  | "untracked"
  | "ignored";

function repoRelative(worktreeRoot: string, path: string): string {
  const rel = relative(resolve(worktreeRoot), resolve(path));
  if (rel === "" || rel === ".") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(worktreeRoot, rel) !== resolve(path)) {
    throw new Error(`Path is outside Git worktree: ${path}`);
  }
  return rel.replaceAll("\\", "/");
}

/** Classify a destination exactly as Git sees it, including ignored files. */
export async function gitPathStatus(worktreeRoot: string, path: string): Promise<GitPathStatus> {
  const rel = repoRelative(worktreeRoot, path);
  const result = await runCommand(
    "git",
    ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all", "--", rel],
    { cwd: worktreeRoot },
  );
  const records = result.stdout.split("\0").filter(Boolean);
  if (records.length > 0) {
    const code = records[0]!.slice(0, 2);
    if (code === "!!") return "ignored";
    if (code === "??") return "untracked";
    if (code === "DD" || code === "AU" || code === "UD" || code === "UA" || code === "DU" || code === "AA" || code === "UU") return "conflicted";
    if (code[0] !== " ") return "staged";
    if (code[1] !== " ") return "modified";
  }

  const tracked = await runCommand("git", ["ls-files", "--error-unmatch", "--", rel], {
    cwd: worktreeRoot,
    allowFailure: true,
  });
  if (tracked.exitCode === 0) return "tracked-clean";
  return (await Bun.file(path).exists()) ? "untracked" : "missing";
}

/** Reject source changes that could be overwritten or make a pull unsafe. Ignored files are allowed. */
export async function ensureCleanSource(sourceRoot: string): Promise<void> {
  const worktree = await gitWorktree(sourceRoot);
  if (resolve(sourceRoot) !== worktree.root) {
    throw new Error(`Source Repository must be the Git worktree root: ${sourceRoot}`);
  }
  const status = await runCommand(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: worktree.root },
  );
  if (status.stdout.length > 0) {
    throw new Error("Source Repository has tracked, staged, conflicted, or nonignored untracked changes");
  }
}

/** Pull only when Git can fast-forward, without ever prompting for credentials. */
export async function gitPullFfOnly(sourceRoot: string): Promise<void> {
  await ensureCleanSource(sourceRoot);
  await runCommand("git", ["pull", "--ff-only"], { cwd: sourceRoot });
}
