import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const targets = {
  "darwin-arm64": { bun: "bun-darwin-arm64", suffix: "darwin_arm64" },
  "linux-x64": { bun: "bun-linux-x64-baseline", suffix: "linux_amd64" },
  "linux-arm64": { bun: "bun-linux-arm64", suffix: "linux_arm64" },
} as const;

type Target = keyof typeof targets;
type Mode = "build" | "package";

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const projectRoot = resolve(import.meta.dir, "..");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: projectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) fail(`Command failed (${exitCode}): ${command.join(" ")}`);
}

const mode = process.argv[2] as Mode | undefined;
if (mode !== "build" && mode !== "package") fail("Usage: release.ts <build|package> --target <target> --version <semver> [--prepare-only]");

const target = argument("--target") as Target | undefined;
if (!target || !(target in targets)) fail(`--target must be one of: ${Object.keys(targets).join(", ")}`);

const version = argument("--version");
if (!version || !semver.test(version)) fail("--version must be a semantic version without a leading v");

const manifest = (await Bun.file(join(projectRoot, "package.json")).json()) as { name?: unknown; version?: unknown };
if (manifest.name !== "agentsmith") fail("package.json name must be agentsmith");
if (manifest.version !== version) fail(`Release version ${version} does not match package.json version ${String(manifest.version)}`);

const targetConfig = targets[target];
const stem = `agentsmith_${version}_${targetConfig.suffix}`;
const releaseRoot = join(projectRoot, "dist", "release");
const stageDirectory = join(releaseRoot, "stage", stem);
const binaryPath = join(stageDirectory, "asmith");
const archivePath = join(releaseRoot, `${stem}.tar.gz`);

if (mode === "build") {
  await rm(stageDirectory, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(stageDirectory, { recursive: true });
  await run(["bun", "build", "src/cli.ts", "--compile", `--target=${targetConfig.bun}`, `--outfile=${binaryPath}`]);
  await chmod(binaryPath, 0o755);
  await copyFile(join(projectRoot, "README.md"), join(stageDirectory, "README.md"));

  if (await Bun.file(join(projectRoot, "LICENSE")).exists()) {
    await copyFile(join(projectRoot, "LICENSE"), join(stageDirectory, "LICENSE"));
  }
}

if (mode === "package" || !process.argv.includes("--prepare-only")) {
  if (!(await Bun.file(binaryPath).exists())) fail(`Missing release binary: ${binaryPath}`);
  const archiveFiles = ["asmith", "README.md"];
  if (await Bun.file(join(stageDirectory, "LICENSE")).exists()) archiveFiles.push("LICENSE");
  await mkdir(releaseRoot, { recursive: true });
  await rm(archivePath, { force: true });
  await run(["tar", "-czf", archivePath, "-C", stageDirectory, ...archiveFiles]);
  await run(["tar", "-tzf", archivePath]);
  console.log(archivePath);
} else {
  console.log(binaryPath);
}
